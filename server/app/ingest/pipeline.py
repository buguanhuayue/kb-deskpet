"""入库流水线（Worker 侧）。

阶段：parsing → chunking → embedding → ready；任一步失败写 error 并置 failed。
状态写进 documents.status，前端直接轮询这个字段即可画进度。
"""
import json
import logging
import time
from pathlib import Path

from app.config import settings
from app.db import tx
from app.ingest.chunker import chunk_blocks, embed_input
from app.ingest.parsers import registry
from app.search.tokenize import to_tsv_text
from app.services.embedding import embed_texts, vec_literal

log = logging.getLogger(__name__)

EMBED_BATCH = 16


def _set_status(conn, doc_id: str, status: str, **fields) -> None:
    sets = ", ".join(f"{k} = %s" for k in fields)
    sql = f"UPDATE documents SET status = %s{', ' + sets if sets else ''} WHERE id = %s"
    conn.execute(sql, (status, *fields.values(), doc_id))


def _write_chunks(doc_id: str, batch, vecs: list[list[float]] | None) -> None:
    """写一批切片。vecs=None 表示无向量模式（关键词可检索，向量路跳过）。"""
    with tx() as conn:
        _set_status(conn, doc_id, "embedding" if vecs is not None else "chunking")
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO chunks (doc_id, dept_id, seq, text, locator, token_count,
                                    embedding, embed_model, tsv)
                SELECT %(doc_id)s, d.dept_id, %(seq)s, %(text)s, %(locator)s::jsonb,
                       %(tok)s, %(emb)s::vector, %(model)s,
                       to_tsvector('simple', %(tsvtext)s)
                FROM documents d WHERE d.id = %(doc_id)s
                ON CONFLICT (doc_id, seq) DO UPDATE
                  SET text = EXCLUDED.text, locator = EXCLUDED.locator,
                      token_count = EXCLUDED.token_count,
                      embedding = EXCLUDED.embedding, tsv = EXCLUDED.tsv,
                      embed_model = EXCLUDED.embed_model
                """,
                [
                    {
                        "doc_id": doc_id,
                        "seq": c.seq,
                        "text": c.text,
                        "locator": json.dumps(c.locator),
                        "tok": c.token_count,
                        "emb": vec_literal(v) if vecs is not None else None,
                        "model": settings.embed_model if vecs is not None else "none",
                        "tsvtext": to_tsv_text(c.text),
                    }
                    for c, v in (zip(batch, vecs) if vecs is not None else ((c, None) for c in batch))
                ],
            )


def ingest_document(doc_id: str) -> None:
    t0 = time.time()

    with tx() as conn:
        doc = conn.execute(
            "SELECT id, title, source_type, storage_path, ext FROM documents WHERE id = %s",
            (doc_id,),
        ).fetchone()
        if not doc:
            log.warning("doc %s 不存在，跳过", doc_id)
            return
        _set_status(conn, doc_id, "parsing", error_code=None, error_msg=None)

    if doc["source_type"] == "text":
        # 纯文本入库时正文存在 ext.content 里
        content = (doc["ext"] or {}).get("content", "")
        blocks, meta = registry.parse_plain(content)
    else:
        path = Path(doc["storage_path"] or "")
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        blocks, meta = registry.parse(path)

    chunks = chunk_blocks(blocks)
    if not chunks:
        raise ValueError("解析后没有任何文本（可能是扫描版 PDF，需要 OCR，属 P1）")

    with tx() as conn:
        _set_status(conn, doc_id, "chunking")
        conn.execute("DELETE FROM chunks WHERE doc_id = %s", (doc_id,))
        conn.execute(
            "UPDATE documents SET ext = ext || %s::jsonb WHERE id = %s",
            (json.dumps(meta), doc_id),
        )

    # 向量化：分批写入。embedding 不可用时按 EMBED_REQUIRED 决定：
    #   true （默认）→ 整篇置 failed，宁可失败也不留不可检索的数据
    #   false        → 清掉半成品，整篇按无向量重写，仅关键词可检索
    total = len(chunks)
    try:
        for i in range(0, total, EMBED_BATCH):
            batch = chunks[i : i + EMBED_BATCH]
            vecs = embed_texts([embed_input(doc["title"], c.text) for c in batch])
            _write_chunks(doc_id, batch, vecs)
            log.info("doc %s 向量化 %s/%s", doc_id, min(i + EMBED_BATCH, total), total)
    except Exception as e:
        if settings.embed_required:
            raise
        log.warning("doc %s 向量化失败，降级为无向量入库（仅关键词可检索）: %s", doc_id, e)
        with tx() as conn:
            conn.execute("DELETE FROM chunks WHERE doc_id = %s", (doc_id,))
        _write_chunks(doc_id, chunks, None)
        with tx() as conn:
            conn.execute(
                "UPDATE documents SET ext = ext || %s::jsonb WHERE id = %s",
                (json.dumps({"embed_degraded": True, "embed_error": str(e)[:300]}), doc_id),
            )

    with tx() as conn:
        _set_status(conn, doc_id, "ready", chunk_count=total, published_at=None)
        conn.execute(
            "UPDATE documents SET published_at = now() WHERE id = %s AND published_at IS NULL",
            (doc_id,),
        )
    log.info("doc %s 入库完成，%s 片，%.1fs", doc_id, total, time.time() - t0)
