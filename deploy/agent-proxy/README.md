# kb-agent：知识小助的工具循环代理

给桌宠补上「模型自己决定查什么」的能力。**WeKnora 一行不改**，用它的检索接口当工具，
外面套一层 Agnes 的 function calling 循环。

## 为什么不直接开 WeKnora 的 agent

试过了，跑不起来。v0.9.0-rerankfix3 这个部署里，`/api/v1/agent-chat/{session_id}`
无论怎么配（绑 agent、开 `agent_config.agent_enabled`、关 thinking）都走 `[PIPELINE]`
rag 流水线，`tool_call` 事件恒为 0 次，耗时恒为 2.6 秒。证据和排查过程见
`.workbuddy/memory/2026-11-24.md`。

自己写循环的代价反而更低：不用重编译 Go 二进制，不用每次升级重放补丁。

## 它做什么

```
桌宠 ──POST /tool-chat──> kb-agent ──tools──> Agnes
                            │
                            ├─ search_knowledge → 转发 WeKnora /api/v1/knowledge-search（透传用户 JWT）
                            └─ get_weather      → wttr.in（免 key）
```

- 最多 3 轮工具调用，总预算 28 秒，超了强制收尾
- 检索范围由**调用方**决定（`kb_ids`），模型只能决定查什么词，不能决定搜哪个库
- 鉴权全程透传用户 JWT，不引入服务账号，权限与手点一致

实测（3 份真实文档、5 个用例）：工具选择 5/5 正确，时延 2.5–6.2 秒。

## 接口

```http
POST /tool-chat
Authorization: Bearer <WeKnora JWT>
X-Tenant-ID: <登录身份的租户>
Content-Type: application/json

{"query": "出差住酒店一晚最多能报多少钱", "kb_ids": ["<知识库 id>"]}
```

返回 SSE：

```
data: {"response_type":"agent_query"}
data: {"response_type":"tool_call","tool_name":"search_knowledge","args":{...}}
data: {"response_type":"tool_summary","content":"调用了 1 次工具（search_knowledge）"}
data: {"response_type":"answer","content":"..."}
data: {"response_type":"complete","elapsed":6.2}
```

`GET /health` 返回配置摘要（不泄露密钥）。

## 部署

```bash
# 1. 传文件
scp deploy/agent-proxy/kb_agent.py deploy/agent-proxy/install.sh demo@<host>:~/kb-agent/

# 2. 安装（自动从 WeKnora 容器取模型密钥 → agent.env 600 → 装 systemd）
bash ~/kb-agent/install.sh

# 3. 验证
curl -s http://localhost:8091/health
```

`install.sh` 做的事：`docker exec WeKnora-app printenv LLM_API_KEY` 导出到
`~/kb-agent/agent.env`（600 权限，不入库），然后写 `/etc/systemd/system/kb-agent.service`
并 enable。**不要把 key 写进代码或仓库**——models 表里那份是加密的，直接用会 401。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGNES_KEY` | 必填 | Agnes API key |
| `AGNES_BASE` | `https://apihub.agnes-ai.com/v1` | 兼容 OpenAI 的端点 |
| `AGNES_MODEL` | `agnes-3.0-flash` | |
| `WEKNORA_BASE` | `http://localhost:18080/api/v1` | |
| `PORT` | `8091` | |
| `MAX_ROUNDS` | `3` | 工具调用轮次上限 |
| `BUDGET_SEC` | `28` | 总耗时预算 |

## 加工具

在 `TOOLS` 里加一个 schema，在 `TOOL_IMPL` 里加一个实现，签名是 `fn(args, ctx)`：

```python
def tool_calendar(args, ctx):
    return '2026-11-25 上午 10:00 部门例会'
```

`ctx` 里有 `auth`（鉴权头）和 `kb_ids`（检索范围），需要访问用户数据时用它。
工具出错不要抛异常——返回一句人能看懂的话，让模型自己决定怎么跟用户解释。

## 已知限制

1. **不带多轮对话**：每次请求独立，用户说「那后天呢」这种指代还接不上。要支持得从
   WeKnora `/messages/{id}/load` 取历史一起喂进去。
2. **没有引用卡片**：答案里有 `[1][2]` 标号，但没发 `references` 事件，桌宠不会渲染
   可点开的引用。检索结果里有 `knowledge_title` 和 `chunk_index`，够做，还没做。
3. **附件不支持**：桌宠在 agent 模式下会跳过带附件的问题，仍走原链路。
4. **kb_ids 必传**：`/knowledge-search` 强制要求检索范围，漏传会 400。
   桌宠侧从 `cfg.kbId` / `askScope` 算出范围，模型无权改。
