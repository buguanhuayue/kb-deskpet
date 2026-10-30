"""检索：向量 + 关键词 → RRF 融合 → 重排。"""
import logging
from dataclasses import dataclass, field

from app.config import settings
from app.db import get_conn
from app.search import sql as S
from app.search.tokenize import to_query
from app.services.embedding import embed_one, vec_literal
from app.services.rerank import rerank

log = logging.getLogger(__name__)


@dataclass
class Hit:
    chunk_id: str
    doc_id: str
    title: str
    text: str
    locator: dict
    rrf: float
    cosine: float | None = None
    rerank: float | None = None
    meta: dict = field(default_factory=dict)

    @property
    def score(self) -> float:
        return self.rerank if self.rerank is not None else self.rrf


def retrieve(question: str, *, uid: str, dept: str | None) -> list[Hit]:
    params = {
        "uid": uid,
        "dept": dept,
        "qtext": to_query(question),
        "cand": settings.candidates,
        "k": settings.rrf_k,
    }

    emb = None
    if settings.embed_enabled:
        try:
            emb = embed_one(question)
            params["emb"] = vec_literal(emb)
        except Exception as e:  # noqa: BLE001
            log.warning("向量化失败，降级为纯关键词检索: %s", e)

    if not params["qtext"].strip() and not emb:
        return []

    query = S.HYBRID if emb else S.KEYWORD_ONLY
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()

    hits = [
        Hit(
            chunk_id=str(r["id"]),
            doc_id=str(r["doc_id"]),
            title=r["title"],
            text=r["text"],
            locator=r["locator"] or {},
            rrf=float(r["rrf"] or 0.0),
            cosine=float(r["cosine"]) if r["cosine"] is not None else None,
            meta={"source_type": r["source_type"], "ext": r["ext"]},
        )
        for r in rows
    ]

    # 重排（可选）：失败自动降级，不阻断
    if hits:
        scored = rerank(question, [h.text for h in hits])
        if scored:
            by_idx = {i: s for i, s in scored}
            for i, h in enumerate(hits):
                h.rerank = by_idx.get(i)
            # 重排没覆盖到的保持原序，按分数稳定排序
            hits.sort(key=lambda h: (h.rerank is not None, h.rerank or 0.0), reverse=True)

    return hits
