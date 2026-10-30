"""RerankProvider：失败一律降级，绝不让重排拖垮整条链路。"""
import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)


def rerank(query: str, docs: list[str], *, top_n: int | None = None) -> list[tuple[int, float]]:
    """返回 [(原始下标, 分数)]，按分数降序。失败时返回空列表由调用方降级。"""
    key = settings.rerank_api_key or settings.embed_api_key
    if not key or not docs:
        return []

    try:
        r = httpx.post(
            f"{settings.rerank_base.rstrip('/')}/rerank",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": settings.rerank_model,
                "query": query,
                "documents": [d[:2000] for d in docs],
                "top_n": top_n or len(docs),
            },
            timeout=30.0,
        )
        if r.status_code >= 400:
            log.warning("rerank %s: %s", r.status_code, r.text[:200])
            return []
        items = r.json().get("results", [])
        return [(int(i["index"]), float(i["relevance_score"])) for i in items]
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning("rerank 降级: %s", e)
        return []
