#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kb-agent：给桌宠做工具循环的窄 agent 代理。

为什么要单独一个服务，而不是改 WeKnora：
  v0.9.0 的 agent 引擎没接进问答链路（/agent-chat 无论怎么配都走 [PIPELINE]，
  详见 .workbuddy/memory/2026-11-24.md），改它得重编译二进制、每次升级重放补丁。
  这里换个思路：拿它现成的 /knowledge-search 当「检索工具」，外面套一层
  function calling 循环。WeKnora 一行不动，升级免疫。

设计边界（刻意做窄）：
  1. 只做工具循环，不做开放式规划；轮次硬上限 3，超预算强制收尾
  2. 工具只有两个：search_knowledge（公司知识）、get_weather（实时天气）
  3. 检索结果必须原样回给模型，不做二次加工，避免引入幻觉
  4. 任何一步失败都要降级出话，不能把用户挂死在转圈里

零第三方依赖：只用标准库，服务器上 `python3 kb_agent.py` 直接跑。

环境变量：
  AGNES_KEY       必填，Agnes 的 API key（不要写进代码）
  AGNES_BASE      默认 https://apihub.agnes-ai.com/v1
  AGNES_MODEL     默认 agnes-3.0-flash
  WEKNORA_BASE    默认 http://localhost:18080/api/v1
  PORT            默认 8091
  MAX_ROUNDS      默认 3
  BUDGET_SEC      默认 28（用户可接受 30 秒内的等待）
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGNES_BASE = os.environ.get('AGNES_BASE', 'https://apihub.agnes-ai.com/v1').rstrip('/')
AGNES_KEY = os.environ.get('AGNES_KEY', '')
AGNES_MODEL = os.environ.get('AGNES_MODEL', 'agnes-3.0-flash')
WEKNORA_BASE = os.environ.get('WEKNORA_BASE', 'http://localhost:18080/api/v1').rstrip('/')
PORT = int(os.environ.get('PORT', '8091'))
MAX_ROUNDS = int(os.environ.get('MAX_ROUNDS', '3'))
BUDGET_SEC = float(os.environ.get('BUDGET_SEC', '28'))
CHUNK_CHARS = 600          # 单个片段回给模型的字数上限，防止上下文被撑爆
MAX_TOOL_CHARS = 6000      # 单次工具结果总字数上限

SYSTEM_PROMPT = """你是「知识小助」，一个带工具的知识库助手。回答前先判断：这个问题需要查资料，还是需要实时信息，还是可以直接回答？

工具使用规则：
1. 凡是涉及公司制度、流程、规定、标准、方案、文档内容的问题，必须先调用 search_knowledge 检索，再基于检索结果回答。不要凭记忆或常识编造公司内部信息。
2. 凡是天气、气温、下雨、穿衣、雾霾等实时信息，必须调用 get_weather。你的训练数据里没有实时天气。
3. 检索结果不足以回答时，可以换一个说法再检索一次（最多两次）。仍然不足时，明确说明「知识库里没有找到」，并说明缺什么。
4. 不要用「根据提供的参考资料」这类空话开头，直接给结论。

回答要求：
- 用简体中文，简洁准确，能用一句话说完就别分段。
- 引用了检索片段时，在句末用 [1][2] 标注对应序号。
- 不要输出你的思考过程，不要复述工具返回的原始 JSON。"""

TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'search_knowledge',
            'description': '在公司知识库中检索文档片段。涉及制度、流程、规定、方案、标准等内部信息时必须调用。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'query': {
                        'type': 'string',
                        'description': '检索词。用文档里可能出现的正式说法，例如把「住宿能报多少钱」写成「住宿费标准 报销限额」',
                    },
                    'top_k': {'type': 'integer', 'description': '返回条数，默认 6'},
                },
                'required': ['query'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'get_weather',
            'description': '查询城市天气预报（实时数据）。天气、气温、下不下雨、穿什么衣服这类问题必须调用。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'city': {'type': 'string', 'description': '城市名，例如 太原'},
                    'day': {'type': 'string', 'enum': ['today', 'tomorrow', 'after_tomorrow']},
                },
                'required': ['city'],
            },
        },
    },
]

WMO = {
    113: '晴', 116: '多云', 119: '阴', 122: '阴天', 134: '沙尘暴', 143: '薄雾',
    149: '烟霾', 248: '雾', 260: '冻雾', 176: '零星小雨', 179: '零星小雪',
    200: '雷阵雨', 227: '吹雪', 230: '暴风雪', 263: '毛毛雨', 266: '毛毛雨',
    293: '零星小雨', 296: '小雨', 299: '中雨', 302: '中雨', 305: '大雨', 308: '大雨',
    311: '冻雨', 314: '冻雨', 317: '雨夹雪', 320: '雨夹雪', 323: '小雪', 326: '小雪',
    329: '中雪', 332: '中雪', 335: '大雪', 338: '大雪', 350: '冰粒', 353: '小阵雨',
    356: '阵雨', 359: '暴雨', 362: '阵雨夹雪', 365: '阵雨夹雪', 368: '阵雪', 371: '阵雪',
    386: '雷阵雨', 389: '强雷雨', 392: '雷阵雪', 395: '强雷阵雪',
}
DIR_ZH = {
    'N': '北风', 'NNE': '北东北风', 'NE': '东北风', 'ENE': '东东北风', 'E': '东风',
    'ESE': '东东南风', 'SE': '东南风', 'SSE': '南东南风', 'S': '南风', 'SSW': '南西南风',
    'SW': '西南风', 'WSW': '西西南风', 'W': '西风', 'WNW': '西西北风', 'NW': '西北风',
    'NNW': '北西北风', 'C': '静风',
}


def http_json(url, payload, headers=None, timeout=45, method='POST'):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    hdrs = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8', 'ignore'))
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %s: %s' % (e.code, e.read().decode('utf-8', 'ignore')[:200]))
    except Exception as e:
        raise RuntimeError('%s: %s' % (type(e).__name__, e))


def agnes_chat(messages, tools=None, timeout=60):
    if not AGNES_KEY:
        raise RuntimeError('AGNES_KEY 未配置')
    body = {'model': AGNES_MODEL, 'messages': messages, 'temperature': 0.3}
    if tools:
        body['tools'] = tools
        body['tool_choice'] = 'auto'
    d = http_json(AGNES_BASE + '/chat/completions', body,
                  {'Authorization': 'Bearer ' + AGNES_KEY}, timeout)
    ch = (d.get('choices') or [{}])[0]
    return ch.get('message') or {}, ch.get('finish_reason')


def tool_search(args, ctx):
    """把检索转发给 WeKnora，用调用者自己的 JWT —— 不引入服务账号，权限与手点一致。

    注意 /knowledge-search 强制要求指定知识库范围（否则 400
    "At least one knowledge_base_id ... must be provided"），
    范围由调用方（桌宠）在请求体里给，模型无权决定搜哪个库。
    """
    query = (args.get('query') or '').strip()
    if not query:
        return '检索词为空，请给出具体要查的内容。'
    kb_ids = ctx.get('kb_ids') or []
    if not kb_ids:
        return '没有可检索的知识库（调用方未指定范围），请提示用户先选择一个知识库。'
    body = {'query': query, 'match_count': int(args.get('top_k') or 6),
            'knowledge_base_ids': kb_ids}
    try:
        d = http_json(WEKNORA_BASE + '/knowledge-search', body, ctx.get('auth') or {}, timeout=40)
    except Exception as e:
        sys.stderr.write('[search] 检索失败: %r\n' % e)
        return '检索接口调用失败：%s' % e

    items = d.get('data') or d.get('items') or []
    if isinstance(items, dict):
        items = items.get('items') or items.get('chunks') or []
    if not items:
        return '知识库没有检索到相关内容（query=%s）。' % query

    lines = []
    for i, it in enumerate(items[:8], 1):
        if not isinstance(it, dict):
            continue
        text = (it.get('content') or it.get('text') or '').strip()
        if not text:
            continue
        src = it.get('knowledge_title') or it.get('title') or it.get('file_name') or ''
        score = it.get('score')
        head = '[%d] %s' % (i, ('（来源：%s）' % src) if src else '')
        if isinstance(score, (int, float)):
            head += '  相关度 %.3f' % float(score)
        lines.append(head + '\n' + text[:CHUNK_CHARS])
    return '\n\n'.join(lines) if lines else '检索结果为空。'


def tool_weather(args, ctx=None):
    city = (args.get('city') or '太原').strip()
    day = {'tomorrow': 1, 'after_tomorrow': 2}.get(args.get('day') or 'today', 0)
    url = 'https://wttr.in/%s?format=j1&lang=zh' % urllib.parse.quote(city)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}),
                                    timeout=12) as r:
            d = json.loads(r.read().decode('utf-8', 'ignore'))
    except Exception as e:
        sys.stderr.write('[weather] %s 请求失败: %r\n' % (city, e))
        return '天气接口不可用（%s），请让用户稍后重试或自行查询。' % e

    days = d.get('weather') or []
    if day >= len(days):
        return '拿不到 %s 的预报数据。' % city
    w = days[day]
    hourly = w.get('hourly') or []
    noon = next((h for h in hourly if h.get('time') == '1200'), hourly[0] if hourly else {})
    code = noon.get('weatherCode')
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = None
    cond = WMO.get(code) or '未知'
    cur = (d.get('current_condition') or [{}])[0]
    astro = (w.get('astronomy') or [{}])[0]
    label = ['今天', '明天', '后天'][day]
    parts = [
        '%s%s：%s，%s℃ ~ %s℃' % (city, label, cond, w.get('mintempC'), w.get('maxtempC')),
        '湿度 %s%%，%s %s km/h' % (noon.get('humidity', cur.get('humidity', '-')),
                                   DIR_ZH.get(noon.get('winddir16Point') or cur.get('winddir16Point'), '风'),
                                   noon.get('windspeedKmph') or cur.get('windspeedKmph')),
    ]
    if day == 0 and cur.get('temp_C'):
        parts.append('当前 %s℃，体感 %s℃' % (cur.get('temp_C'), cur.get('FeelsLikeC')))
    if astro.get('sunrise'):
        parts.append('日出 %s 日落 %s' % (astro.get('sunrise'), astro.get('sunset')))
    return '；'.join(parts) + '。（数据源 wttr.in）'


TOOL_IMPL = {'search_knowledge': tool_search, 'get_weather': tool_weather}


def run_agent(query, ctx, emit):
    """工具循环。emit 用于向调用方推送进度事件。ctx 携带鉴权头与检索范围。"""
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': query}]
    t0 = time.time()
    used = []

    for rnd in range(MAX_ROUNDS):
        if time.time() - t0 > BUDGET_SEC:
            emit({'response_type': 'tool_call', 'tool_name': 'budget', 'content': '时间预算已用完，直接作答'})
            break
        try:
            msg, finish = agnes_chat(messages, TOOLS)
        except Exception as e:
            return '模型调用失败：%s' % e, used

        calls = msg.get('tool_calls') or []
        if not calls:
            return (msg.get('content') or '').strip() or '没有生成有效回答。', used

        messages.append({'role': 'assistant', 'content': msg.get('content') or None, 'tool_calls': calls})
        for c in calls:
            fn = c.get('function') or {}
            name = fn.get('name') or ''
            try:
                args = json.loads(fn.get('arguments') or '{}')
            except Exception:
                args = {}
            emit({'response_type': 'tool_call', 'tool_name': name, 'args': args})
            impl = TOOL_IMPL.get(name)
            if impl is None:
                out = '未知工具：%s' % name
            else:
                try:
                    out = impl(args, ctx)
                    sys.stderr.write('[tool] %s %s -> %d 字\n' % (name, json.dumps(args, ensure_ascii=False), len(out)))
                except Exception as e:
                    out = '工具执行出错：%s' % e
                    sys.stderr.write('[tool] %s 异常: %r\n' % (name, e))
            used.append({'name': name, 'args': args})
            messages.append({'role': 'tool', 'tool_call_id': c.get('id'), 'content': out[:MAX_TOOL_CHARS]})

    # 轮次或预算用尽：去掉工具再要一次，保证有话说
    try:
        msg, _ = agnes_chat(messages, None)
        return (msg.get('content') or '').strip() or '已经查过，但没能整理出确定答案。', used
    except Exception as e:
        return '模型收尾失败：%s' % e, used


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Tenant-ID')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path.split('?')[0] in ('/health', '/'):
            body = json.dumps({
                'ok': True, 'model': AGNES_MODEL, 'key': bool(AGNES_KEY),
                'weknora': WEKNORA_BASE, 'max_rounds': MAX_ROUNDS, 'budget': BUDGET_SEC,
            }).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path != '/tool-chat':
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
        except Exception:
            payload = {}
        query = (payload.get('query') or '').strip()
        auth = {}
        if self.headers.get('Authorization'):
            auth['Authorization'] = self.headers['Authorization']
        if self.headers.get('X-Tenant-ID'):
            auth['X-Tenant-ID'] = self.headers['X-Tenant-ID']

        # 检索范围由调用方给，模型无权决定搜哪个库
        kb_ids = payload.get('kb_ids')
        if not kb_ids and payload.get('kb_id'):
            kb_ids = [payload['kb_id']]
        ctx = {'auth': auth, 'kb_ids': [str(k) for k in (kb_ids or []) if k]}

        # SSE 头必须带上 X-Accel-Buffering，否则反向代理会把流攒成一坨
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        def emit(obj):
            try:
                self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

        if not query:
            emit({'response_type': 'error', 'content': '缺少 query'})
            emit({'response_type': 'complete'})
            return

        t0 = time.time()
        emit({'response_type': 'agent_query'})
        try:
            answer, used = run_agent(query, ctx, emit)
        except Exception as e:
            answer, used = '处理失败：%s' % e, []
        if used:
            names = '、'.join(sorted({u['name'] for u in used}))
            emit({'response_type': 'tool_summary', 'content': '调用了 %d 次工具（%s）' % (len(used), names)})
        emit({'response_type': 'answer', 'content': answer})
        emit({'response_type': 'complete', 'elapsed': round(time.time() - t0, 1)})
        self.close_connection = True


if __name__ == '__main__':
    if not AGNES_KEY:
        print('警告：AGNES_KEY 未设置，/tool-chat 会失败', file=sys.stderr)
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('kb-agent 监听 :%d  model=%s  weknora=%s' % (PORT, AGNES_MODEL, WEKNORA_BASE), file=sys.stderr)
    srv.serve_forever()
