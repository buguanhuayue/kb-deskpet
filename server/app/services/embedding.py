"""EmbeddingProvider：OpenAI 兼容 /v1/embeddings。

换供应商只改 .env 的 EMBED_* 四行（维度必须 1024，否则 DDL 要重建）。
"""
import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)

BATCH = 16


class EmbeddingError(RuntimeError):
    pass


def embed_texts(texts: list[str], *, timeout: float = 60.0) -> list[list[float]]:
    if not settings.embed_enabled:
        raise EmbeddingError("EMBED_API_KEY 未配置，无法向量化")

    out: list[list[float]] = []
    with httpx.Client(timeout=timeout) as client:
        for i in range(0, len(texts), BATCH):
            batch = [t[:4000] for t in texts[i : i + BATCH]]
            for attempt in range(3):
                try:
                    r = client.post(
                        f"{settings.embed_base.rstrip('/')}/embeddings",
                        headers={"Authorization": f"Bearer {settings.embed_api_key}"},
                        json={"model": settings.embed_model, "input": batch},
                    )
                    if r.status_code >= 400:
                        raise EmbeddingError(f"{r.status_code} {r.text[:300]}")
                    data = r.json()["data"]
                    data.sort(key=lambda d: d.get("index", 0))
                    vecs = [d["embedding"] for d in data]
                    break
                except (httpx.HTTPError, EmbeddingError, KeyError) as e:
                    if attempt == 2:
                        raise EmbeddingError(f"embedding 失败: {e}") from e
                    log.warning("embedding retry %s: %s", attempt + 1, e)
            for v in vecs:
                if len(v) != settings.embed_dim:
                    raise EmbeddingError(
                        f"维度不符：模型返回 {len(v)}，DDL 是 {settings.embed_dim}。"
                        "换模型必须重建 chunks.embedding 并全量重跑。"
                    )
            out.extend(vecs)
    return out


def embed_one(text: str) -> list[float]:
    return embed_texts([text])[0]


def vec_literal(v: list[float]) -> str:
    """pgvector 的文本字面量，配合 %s::vector 使用。"""
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"
