"""生成：拒答闸门比提示词重要。

顺序：检索 → 闸门判定 → 拼上下文 → 流式生成 → 附引用。
闸门不通过就直接拒答，绝不把"没检索到"交给模型自由发挥。
"""
import json
from collections.abc import AsyncIterator

from app.config import settings
from app.search.retrieve import Hit
from app.services.llm import stream_chat

SYSTEM = """你是公司内部知识库助手。只能依据【资料】回答，规则：

1. 资料里没有的信息，直接说"知识库里没有查到相关内容"，禁止猜测、禁止用常识补全。
2. 每个结论后面标注来源编号，如 [1]；同一句引用多条写 [1][3]。
3. 资料互相矛盾时，把两种说法都列出来并标注各自来源，不要替用户裁决。
4. 用简洁的中文，先给结论再给细节，不要复述问题。
5. 涉及数字、金额、日期、人名时逐字照抄资料，不要换算或改写。"""

REFUSE_TEXT = "知识库里没有查到相关内容。可以换个说法再问，或者把这部分资料先传上来。"


def format_locator(loc: dict) -> str:
    if not loc:
        return ""
    if "page" in loc:
        return f"第 {loc['page']} 页"
    if "start" in loc:
        s, e = int(loc["start"]), int(loc.get("end", 0))
        return f"{s // 60:02d}:{s % 60:02d}–{e // 60:02d}:{e % 60:02d}"
    return ""


def build_context(hits: list[Hit]) -> str:
    lines = []
    for i, h in enumerate(hits, 1):
        where = format_locator(h.locator)
        head = f"[{i}] 《{h.title}》" + (f" {where}" if where else "")
        lines.append(f"{head}\n{h.text}")
    return "\n\n---\n\n".join(lines)


def citations(hits: list[Hit]) -> list[dict]:
    return [
        {
            "index": i,
            "doc_id": h.doc_id,
            "title": h.title,
            "locator": h.locator,
            "locator_text": format_locator(h.locator),
            "snippet": h.text[:160],
            "score": round(h.score, 4),
        }
        for i, h in enumerate(hits, 1)
    ]


def should_refuse(hits: list[Hit]) -> bool:
    if not hits:
        return True
    best = hits[0]
    if best.rerank is not None:
        return best.rerank < settings.not_found_threshold
    if best.cosine is not None:
        # 余弦没有重排那么有区分度，用更松的下限兜底
        return best.cosine < 0.30
    return False


def _sse(event: str, data: dict | str) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


async def answer_stream(question: str, hits: list[Hit]) -> AsyncIterator[str]:
    yield _sse("retrieval", {"count": len(hits), "top_score": round(hits[0].score, 4) if hits else 0})

    if should_refuse(hits):
        yield _sse("token", {"delta": REFUSE_TEXT})
        yield _sse("citations", [])
        yield _sse("done", {"refused": True})
        return

    top = hits[: settings.top_k]
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"【资料】\n{build_context(top)}\n\n【问题】\n{question}"},
    ]

    try:
        async for delta in stream_chat(messages):
            yield _sse("token", {"delta": delta})
    except Exception as e:  # noqa: BLE001
        yield _sse("error", {"message": f"生成失败: {e}"})
        return

    yield _sse("citations", citations(top))
    yield _sse("done", {"refused": False})
