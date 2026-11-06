"""架构师风险点 3、4：重排降级（铁律 5）+ 向量 embedding 降级。

- rerank 返回 [] → retrieve 主链路不中断、保持原序。
- embed_one 失败 → 自动降为 keyword-only，不抛异常。

settings 是 pydantic 实例（embed_enabled 是 @property 不可直接 setattr），
故 patch 的是模块级 settings 引用，指向一个独立 Settings 实例。
"""
from unittest import mock

import pytest

from app.config import Settings
from app.search import retrieve
from app.search.retrieve import Hit


def _settings(embed_key: str = "k") -> Settings:
    return Settings(embed_api_key=embed_key)  # 非空 → embed_enabled=True


def _row(**over) -> dict:
    base = {
        "id": "c1", "doc_id": "d1", "title": "T", "text": "X",
        "locator": {"page": 3}, "rrf": 0.02, "cosine": 0.55,
        "source_type": "pdf", "ext": {"page": 3},
    }
    base.update(over)
    return base


def _make_conn(rows):
    conn = mock.MagicMock()
    conn.execute.return_value.fetchall.return_value = rows
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = conn
    ctx.__exit__.return_value = False
    return ctx, conn


def _patch_retrieve(conn_ctx, conn, *, embed_key="k",
                   embed_side_effect=None, embed_return=None,
                   rerank_return=None, skip_vec_literal=False):
    """组合 patch 工具：一次 patch retrieve 模块所有外部依赖。"""
    import app.search.retrieve as R
    import app.search.sql as S

    patches = [
        mock.patch.object(R, "settings", _settings(embed_key)),
        mock.patch.object(R, "get_conn", return_value=conn_ctx),
        mock.patch.object(R, "rerank", return_value=rerank_return if rerank_return is not None else []),
        mock.patch.object(R, "vec_literal", return_value="[0.1,0.2]" if not skip_vec_literal else "[x]"),
    ]
    if embed_side_effect is not None:
        patches.append(mock.patch.object(R, "embed_one", side_effect=embed_side_effect))
    elif embed_return is not None:
        patches.append(mock.patch.object(R, "embed_one", return_value=embed_return))

    started = [p.start() for p in patches]
    return started, patches


# ---------- 风险点 4：embedding 失败 → keyword-only 降级 ----------

def test_retrieve_degrades_to_keyword_only_when_embed_fails():
    """embed_one 抛异常 → 不中断，走 KEYWORD_ONLY（不带向量路）。"""
    import app.search.retrieve as R
    import app.search.sql as S

    rows = [_row(cosine=None)]
    ctx, conn = _make_conn(rows)
    _patch_retrieve(ctx, conn, embed_key="k",
                    embed_side_effect=RuntimeError("embed down"))
    hits = R.retrieve("问题", uid="u", dept="dp")

    assert isinstance(hits, list) and len(hits) == 1
    # KEYWORD_ONLY 的 cosine 是 NULL → hit.cosine 为 None
    assert hits[0].cosine is None
    # 走的是 KEYWORD_ONLY SQL
    executed_sql = conn.execute.call_args[0][0]
    assert executed_sql == S.KEYWORD_ONLY, \
        "embed 失败时应降级到 KEYWORD_ONLY，实际执行了 HYBRID"


def test_retrieve_uses_hybrid_when_embed_ok():
    """embed 成功 → 走 HYBRID SQL，且参数带 emb。"""
    import app.search.retrieve as R
    import app.search.sql as S

    rows = [_row()]
    ctx, conn = _make_conn(rows)
    _patch_retrieve(ctx, conn, embed_key="k",
                    embed_return=[0.1] * 1024)
    hits = R.retrieve("问题", uid="u", dept="dp")

    executed_sql = conn.execute.call_args[0][0]
    assert executed_sql == S.HYBRID, "embed 成功时应走 HYBRID"
    assert hits[0].cosine == 0.55


def test_retrieve_empty_query_returns_no_rows():
    """查询词全被去停用词滤掉且无向量 → 直接返回 []（不发 SQL）。"""
    import app.search.retrieve as R

    ctx, conn = _make_conn([])
    with mock.patch.object(R, "embed_one", return_value=None):
        with mock.patch.object(R, "to_query", return_value=""):
            with mock.patch.object(R, "get_conn", return_value=ctx):
                with mock.patch.object(R, "settings", _settings("")):
                    hits = R.retrieve("的了吗", uid="u", dept="dp")
    assert hits == []
    conn.execute.assert_not_called()  # 空查询不应发 SQL


# ---------- 风险点 3：rerank 失败 → [] → 保持原序不中断 ----------

def test_rerank_empty_keeps_original_order():
    """rerank 返回 [] → 不重排，hits 按原始 RRF 顺序保留。"""
    import app.search.retrieve as R

    rows = [_row(rrf=0.9, cosine=0.9), _row(rrf=0.5, cosine=0.5), _row(rrf=0.1, cosine=0.1)]
    ctx, conn = _make_conn(rows)
    started, patches = _patch_retrieve(ctx, conn, embed_key="k",
                                       embed_return=[0.1] * 1024,
                                       rerank_return=[])
    try:
        hits = R.retrieve("q", uid="u", dept="dp")
    finally:
        for p in patches:
            p.stop()

    # 重排降级：保持原始 RRF 序
    assert [h.rrf for h in hits] == [0.9, 0.5, 0.1]
    # rerank 全 None，score 回退到 rrf
    assert [h.score for h in hits] == [0.9, 0.5, 0.1]


def test_rerank_success_reorders_by_score():
    """rerank 返回 (idx, score) → 按重排分稳定重排。"""
    import app.search.retrieve as R

    rows = [_row(rrf=0.9), _row(rrf=0.5), _row(rrf=0.1)]
    ctx, conn = _make_conn(rows)
    started, patches = _patch_retrieve(ctx, conn, embed_key="k",
                                       embed_return=[0.1] * 1024,
                                       rerank_return=[(2, 0.95), (0, 0.5), (1, 0.1)])
    try:
        hits = R.retrieve("q", uid="u", dept="dp")
    finally:
        for p in patches:
            p.stop()

    assert [h.rrf for h in hits] == [0.1, 0.9, 0.5], \
        f"应按 rerank 重排 (idx2 最前)，实际 {[h.rrf for h in hits]}"


def test_hit_score_prefers_rerank():
    """Hit.score：有 rerank 用 rerank，否则回退 rrf（retrieve.py:28-29）。"""
    h = Hit("c", "d", "t", "x", {}, rrf=0.3, rerank=0.7, cosine=0.9)
    assert h.score == 0.7
    h2 = Hit("c", "d", "t", "x", {}, rrf=0.3, rerank=None, cosine=0.9)
    assert h2.score == 0.3
