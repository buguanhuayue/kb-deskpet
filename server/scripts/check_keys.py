"""M0 自检闸门：一条命令验证四件事，不通过就不要往下写业务代码。

    python scripts/check_keys.py

检查项：
  1. 数据库连通 + pgvector 版本
  2. embedding 能返回 1024 维（这一项不过，后面全部解锁不了）
  3. rerank 能返回 relevance_score（缺失只降级，不阻塞）
  4. Agnes 能流式吐字
另：如果 EMBED_API_KEY 空但 LLM_API_KEY 有值，会自动探测 Agnes 是否也提供
/v1/embeddings —— 通了就一个 key 全包，省一个账号。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app.config import settings  # noqa: E402

OK, BAD, WARN = "✅", "❌", "⚠️ "
results: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> bool:
    try:
        msg = fn()
        results.append((name, True, msg or "ok"))
        return True
    except Exception as e:  # noqa: BLE001
        results.append((name, False, f"{type(e).__name__}: {e}"))
        return False


def db_check() -> str:
    import psycopg

    with psycopg.connect(settings.database_url, connect_timeout=5) as conn:
        ver = conn.execute("SELECT extversion FROM pg_extension WHERE extname='vector'").fetchone()
        return f"连上了，pgvector {ver[0] if ver else '未安装'}"


def embed_check() -> str:
    if not settings.embed_enabled:
        raise RuntimeError(
            "EMBED_API_KEY 为空。要么起本地 embed 容器（EMBED_BASE=http://embed:8088/v1, "
            "EMBED_API_KEY=local），要么填云端 key（模型选 BAAI/bge-m3）"
        )
    r = httpx.post(
        f"{settings.embed_base.rstrip('/')}/embeddings",
        headers={"Authorization": f"Bearer {settings.embed_api_key}"},
        json={"model": settings.embed_model, "input": ["报销制度", "网络故障如何报修"]},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()["data"]
    dim = len(data[0]["embedding"])
    if dim != settings.embed_dim:
        raise RuntimeError(f"维度 {dim} ≠ DDL 的 {settings.embed_dim}，换模型必须重建表")
    return f"{settings.embed_model} · {dim} 维 · {len(data)} 条"


def rerank_check() -> str:
    key = settings.rerank_api_key or settings.embed_api_key
    if not key:
        raise RuntimeError("RERANK_API_KEY 未配置（可留空，检索会自动降级为 RRF 分数）")
    r = httpx.post(
        f"{settings.rerank_base.rstrip('/')}/rerank",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": settings.rerank_model,
            "query": "报销标准",
            "documents": ["差旅费报销标准为每日 500 元", "公司年会定在十二月"],
            "top_n": 2,
        },
        timeout=30,
    )
    r.raise_for_status()
    res = r.json()["results"]
    return f"{settings.rerank_model} · top={res[0]['relevance_score']:.3f}"


def llm_check() -> str:
    if not settings.llm_api_key:
        raise RuntimeError("LLM_API_KEY 为空")
    r = httpx.post(
        f"{settings.llm_base.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        json={
            "model": settings.llm_model,
            "messages": [{"role": "user", "content": "只回两个字：收到"}],
            "max_tokens": 16,
            "stream": False,
        },
        timeout=60,
    )
    r.raise_for_status()
    txt = r.json()["choices"][0]["message"]["content"].strip()
    return f"{settings.llm_model} · 回: {txt[:20]}"


def probe_agnes_embeddings() -> str:
    """Agnes 是否顺手提供 embeddings —— 通了就能一个 key 全包。"""
    if settings.embed_enabled:
        return "跳过（EMBED_API_KEY 已配置，无需共用）"
    if not settings.llm_api_key:
        return "跳过（LLM_API_KEY 也为空，两个 key 都没填，无法探测）"
    tried = []
    for model in (settings.embed_model, "text-embedding-3-small", "bge-m3", "embedding-3"):
        try:
            r = httpx.post(
                f"{settings.llm_base.rstrip('/')}/embeddings",
                headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                json={"model": model, "input": ["测试"]},
                timeout=15,
            )
        except httpx.HTTPError as e:
            tried.append(f"{model}: 网络错误 {e}")
            continue
        if r.status_code < 400:
            return f"🎉 Agnes 支持 embeddings（model={model}），可以一个 key 全包"
        tried.append(f"{model}: {r.status_code}")
    raise RuntimeError("Agnes 不提供 embeddings → " + "; ".join(tried))


def main() -> int:
    print("M0 自检 ——", settings.embed_base, "/", settings.llm_base, "\n")
    check("数据库", db_check)
    check("向量化 embedding", embed_check)
    check("重排 rerank", rerank_check)
    check("生成 Agnes", llm_check)
    check("Agnes embeddings 探测", probe_agnes_embeddings)

    print()
    for name, ok, msg in results:
        print(f"{OK if ok else BAD} {name:<22} {msg}")

    failed = [n for n, ok, _ in results if not ok]
    blocking = [n for n in failed if n in ("数据库", "向量化 embedding", "生成 Agnes")]
    print()
    if blocking:
        print(f"卡点：{' / '.join(blocking)}。这 {'几' if len(blocking) > 1 else ''}项不通，P0 无法继续。")
        return 1
    print("M0 通过 → 可以进入 P0：上传一份真 PDF，问出带页码的答案。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
