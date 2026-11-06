"""架构师风险点 2、8：拒答闸门（铁律 4）+ EMBED_REQUIRED=false 静默关闸门。

- should_refuse()：rerank<0.35 或 cosine<0.30 → 拒答；高分通过。
- 风险点 8：降级入库 embed_model='none'/cosine=None → should_refuse 返回 False
  （不拒答直接生成）——这是隐患不是 bug，需被记录在案。
"""
import asyncio
from unittest import mock

import pytest

from app.config import settings
from app.search import answer
from app.search.retrieve import Hit


def _hit(rerank=None, cosine=None, rrf=0.05, **kw) -> Hit:
    return Hit(
        chunk_id="c", doc_id="d", title="t", text="x",
        locator={}, rrf=rrf, cosine=cosine, rerank=rerank, **kw,
    )


# ---------- 风险点 2：拒答闸门 ----------

def test_refuse_when_no_hits():
    assert answer.should_refuse([]) is True


def test_refuse_when_rerank_below_threshold():
    # rerank 0.30 < 0.35 → 拒答
    with mock_settings(not_found_threshold=0.35):
        assert answer.should_refuse([_hit(rerank=0.30, cosine=0.9)]) is True


def test_pass_when_rerank_at_or_above_threshold():
    # rerank 0.40 >= 0.35 → 通过（cosine 缺省）
    with mock_settings(not_found_threshold=0.35):
        assert answer.should_refuse([_hit(rerank=0.40, cosine=0.9)]) is False


def test_rerank_takes_priority_over_cosine():
    # 同时有 rerank 与 cosine 时以 rerank 为准（answer.py:63-64）
    with mock_settings(not_found_threshold=0.35):
        # rerank 高 0.5 通过，即使 cosine 很低 0.1（不会走 cosine 分支）
        assert answer.should_refuse([_hit(rerank=0.50, cosine=0.10)]) is False


def test_refuse_when_cosine_below_floor():
    # 无 rerank（None），cosine 0.25 < 0.30 → 拒答
    with mock_settings(not_found_threshold=0.35):
        assert answer.should_refuse([_hit(rerank=None, cosine=0.25)]) is True


def test_pass_when_cosine_at_or_above_floor():
    # 无 rerank，cosine 0.40 >= 0.30 → 通过
    with mock_settings(not_found_threshold=0.35):
        assert answer.should_refuse([_hit(rerank=None, cosine=0.40)]) is False


def test_only_top_hit_matters():
    # 闸门只看 best=hits[0]，后面的低分不影响
    with mock_settings(not_found_threshold=0.35):
        hits = [_hit(rerank=0.60), _hit(rerank=0.01)]
        assert answer.should_refuse(hits) is False


class mock_settings:
    """临时把 settings.not_found_threshold 换成自定义值。"""

    def __init__(self, not_found_threshold: float):
        self._thr = not_found_threshold

    def __enter__(self):
        self._old = settings.not_found_threshold
        settings.not_found_threshold = self._thr
        return self

    def __exit__(self, *a):
        settings.not_found_threshold = self._old


# ---------- 风险点 8：EMBED_REQUIRED=false 静默关闸门（记录在案） ----------

def test_degraded_cosine_none_bypasses_refusal():
    """架构师风险点 8：降级入库后 best.cosine is None 且 rerank is None
    → should_refuse 落到最后一个 return False → 不拒答直接生成。

    这是一个**隐患**（非 bug）：无向量模式下拒答闸门形同虚设，
    低质量检索也会直接进 LLM 生成。测试固化该行为，便于后续若加
    "无向量也必须拒答"的兜底时，此处翻红提示契约变化。
    """
    degraded = _hit(rerank=None, cosine=None, rrf=0.0001)
    # 走默认 settings，不 mock 阈值——因为根本没有 rerank/cosine 可比较
    assert answer.should_refuse([degraded]) is False, (
        "EMBED_REQUIRED=false 降级入库(cosine=None)时闸门不拒答——架构师标注的隐患，"
        "若产品要求无向量也强制拒答，需改 should_refuse 并翻红此断言"
    )


def test_answer_stream_refuses_without_calling_llm():
    """拒答分支：吐 REFUSE_TEXT + citations=[] + done(refused=True)，且不调 LLM。"""
    import app.search.answer as A

    llm_calls = {"n": 0}

    async def _no_llm(messages):
        llm_calls["n"] += 1
        yield "should never be called"

    low = _hit(rerank=0.10, cosine=0.10)
    with mock_settings(not_found_threshold=0.35):
        with mock.patch.object(A, "stream_chat", _no_llm):
            events = []

            async def _collect():
                async for ev in A.answer_stream("问题", [low]):
                    events.append(ev)

            asyncio.run(_collect())

    assert llm_calls["n"] == 0, "拒答分支绝不调 LLM"
    joined = "\n".join(events)
    assert A.REFUSE_TEXT in joined
    # json.dumps 默认不带空格 → "refused":true
    assert '"refused":true' in joined.replace(" ", "")


def test_answer_stream_passes_and_calls_llm():
    """高分分支：调 LLM、吐 citations + done(refused=false)。"""
    import app.search.answer as A

    llm_calls = {"n": 0}

    async def _fake_llm(messages):
        llm_calls["n"] += 1
        yield "答案A"
        yield "答案B"

    high = _hit(rerank=0.8, cosine=0.9)
    with mock_settings(not_found_threshold=0.35):
        with mock.patch.object(A, "stream_chat", _fake_llm):
            events = []

            async def _collect():
                async for ev in A.answer_stream("问题", [high]):
                    events.append(ev)

            asyncio.run(_collect())

    assert llm_calls["n"] == 1, "高分通过必须调 LLM 一次"
    joined = "\n".join(events)
    assert "答案A" in joined and "答案B" in joined
    assert '"refused":false' in joined.replace(" ", "")
    # citations 应包含 top_k 内的条目
    assert '"index":1' in joined.replace(" ", "")


def test_build_context_and_format_locator():
    """上下文拼接与 locator 文案。"""
    h_pdf = _hit(cosine=0.9)
    h_pdf.locator = {"page": 7}
    h_txt = _hit(cosine=0.8)
    h_txt.locator = {"offset": 0}
    ctx = answer.build_context([h_pdf, h_txt])
    assert "《t》 第 7 页" in ctx
    assert "《t》" in ctx
    # 视频 locator：start=3725s → 62:05，end=3830s → 63:50
    h_vid = _hit(cosine=0.7)
    h_vid.locator = {"start": 3725, "end": 3830}
    assert answer.format_locator(h_vid.locator) == "62:05–63:50"
