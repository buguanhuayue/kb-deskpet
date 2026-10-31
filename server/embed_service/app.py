"""本地向量化 / 重排服务（OpenAI 兼容），仅给 kb-deskpet 内部调用。

为什么自己起一个而不是用现成镜像：
  ghcr.io 上的 text-embeddings-inference 拉不下来，而 huggingface.co 在这台机器上是 000。
  自建镜像只依赖 PyPI + hf-mirror，可控且小。

模型：
  embedding  BAAI/bge-m3              1024 维，与硅基流动同名同权重，
                                      日后切回云端不会让已有向量失效
  rerank     BAAI/bge-reranker-base   可选，加载失败 /v1/rerank 直接 501，
                                      调用方 rerank.py 本来就降级，不影响主链路

权重落 /models 卷，容器重建不重下。
"""
import logging
import math
import os
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

EMBED_MODEL = os.getenv("EMBED_MODEL", "jinaai/jina-embeddings-v3")
RERANK_MODEL = os.getenv("RERANK_MODEL", "jinaai/jina-reranker-v2-base-multilingual")
# DDL 锁死 1024 维，所以只有 1024 维的模型能上岗；主模型不在 fastembed
# 支持列表里时按这个顺序退，退不到就报错，绝不静默换维度。
EMBED_FALLBACKS = [
    m.strip()
    for m in os.getenv(
        "EMBED_FALLBACKS",
        "jinaai/jina-embeddings-v3,intfloat/multilingual-e5-large,snowflake/snowflake-arctic-embed-l",
    ).split(",")
    if m.strip()
]
REQUIRED_DIM = int(os.getenv("EMBED_DIM", "1024"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("embed")

app = FastAPI(title="kb-embed", version="1.0")

_state: dict = {
    "embed": None,
    "rerank": None,
    "dim": None,
    "model_name": None,
    "rerank_name": None,
    "embed_error": None,
    "rerank_error": None,
    "loading": True,
}
_lock = threading.Lock()  # ONNX 单实例，串行化避免并发吃爆内存


def _load() -> None:
    try:
        from fastembed import TextEmbedding

        supported = {m["model"]: m for m in TextEmbedding.list_supported_models()}
        for name in dict.fromkeys([EMBED_MODEL, *EMBED_FALLBACKS]):
            info = supported.get(name)
            if not info:
                log.warning("模型 %s 不在 fastembed 支持列表，跳过", name)
                continue
            if int(info.get("dim", 0)) != REQUIRED_DIM:
                log.warning("模型 %s 是 %s 维，DDL 要 %s 维，跳过", name, info.get("dim"), REQUIRED_DIM)
                continue
            log.info("加载 embedding 模型 %s（首次会从 hf-mirror 下载权重）", name)
            m = TextEmbedding(model_name=name)
            dim = len(next(iter(m.embed(["预热"]))))
            if dim != REQUIRED_DIM:
                log.warning("实测 %s 维 ≠ %s，跳过", dim, REQUIRED_DIM)
                continue
            _state["embed"], _state["dim"], _state["model_name"] = m, dim, name
            log.info("embedding 就绪 %s dim=%s", name, dim)
            break
        else:
            raise RuntimeError(f"没有可用的 {REQUIRED_DIM} 维模型，试过: {[EMBED_MODEL, *EMBED_FALLBACKS]}")
    except Exception as e:  # noqa: BLE001
        _state["embed_error"] = f"{type(e).__name__}: {e}"[:500]
        log.exception("embedding 加载失败")

    try:
        try:
            from fastembed import TextCrossEncoder  # 老版本从这里导出
        except ImportError:
            from fastembed.rerank.cross_encoder import TextCrossEncoder  # 0.7.x 路径

        log.info("加载 rerank 模型 %s", RERANK_MODEL)
        _state["rerank"] = TextCrossEncoder(model_name=RERANK_MODEL)
        _state["rerank_name"] = RERANK_MODEL
        log.info("rerank 就绪 %s", RERANK_MODEL)
    except Exception as e:  # noqa: BLE001
        _state["rerank_error"] = f"{type(e).__name__}: {e}"[:500]
        log.warning("rerank 不可用（不影响检索，会自动降级）: %s", e)

    _state["loading"] = False


@app.on_event("startup")
def _startup() -> None:
    # 后台线程加载：下载 2GB 权重期间 /health 仍可访问，能看到进度
    threading.Thread(target=_load, name="loader", daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if _state["embed"] is not None else ("loading" if _state["loading"] else "error"),
        "embed_model": _state["model_name"] or EMBED_MODEL,
        "dim": _state["dim"],
        "embed_ready": _state["embed"] is not None,
        "embed_error": _state["embed_error"],
        "rerank_model": _state["rerank_name"],
        "rerank_ready": _state["rerank"] is not None,
        "rerank_error": _state["rerank_error"],
    }


class EmbedReq(BaseModel):
    model: str | None = None
    input: str | list[str]
    dimensions: int | None = None  # 兼容参数，不生效（维度由模型决定）


@app.post("/v1/embeddings")
def embeddings(req: EmbedReq) -> dict:
    m = _state["embed"]
    if m is None:
        raise HTTPException(503, detail=f"embedding 未就绪: {_state['embed_error'] or '加载中'}")

    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    if not texts:
        raise HTTPException(400, detail="input 为空")
    texts = [t[:8000] if t.strip() else "空" for t in texts]

    with _lock:
        vecs = [v.tolist() for v in m.embed(texts, batch_size=8)]

    return {
        "object": "list",
        "model": _state["model_name"] or EMBED_MODEL,
        "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)],
        "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
    }


class RerankReq(BaseModel):
    model: str | None = None
    query: str
    documents: list[str]
    top_n: int | None = None


@app.post("/v1/rerank")
def rerank(req: RerankReq) -> dict:
    m = _state["rerank"]
    if m is None:
        # 501 而不是 500：调用方据此知道「这台机器没开重排」，直接降级
        raise HTTPException(501, detail=f"rerank 不可用: {_state['rerank_error'] or '未加载'}")
    if not req.documents:
        return {"results": [], "model": _state["rerank_name"]}

    docs = [d[:2000] for d in req.documents]
    with _lock:
        raw = list(m.rerank(req.query, docs))

    # bge-reranker 输出的是 logits（可能为负）。硅基流动那侧返回的是 0~1 的
    # relevance_score，这里做 sigmoid 让两边的阈值语义一致（NOT_FOUND_THRESHOLD）。
    scores = [1.0 / (1.0 + math.exp(-x)) if x > -30 and x < 30 else (1.0 if x >= 30 else 0.0) for x in raw]
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    if req.top_n:
        order = order[: req.top_n]
    return {
        "results": [{"index": i, "relevance_score": round(scores[i], 6)} for i in order],
        "model": _state["rerank_name"],
    }


@app.get("/v1/models")
def models() -> dict:
    return {"data": [{"id": _state["model_name"] or EMBED_MODEL, "object": "model", "owned_by": "local"}]}
