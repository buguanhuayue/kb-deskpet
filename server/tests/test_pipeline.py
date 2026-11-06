"""架构师风险点 1、7：入库幂等（铁律 7）+ 向量维度校验（铁律 2）。

- 幂等：pipeline.py 先 DELETE 后写 + ON CONFLICT (doc_id,seq) DO UPDATE。
- 维度：embedding.py:46 入库前 len(v) != embed_dim 抛错。
纯逻辑部分用 mock 掉 DB，断言调用顺序与 SQL 形态。
"""
import json
from unittest import mock

import pytest

from app.ingest import pipeline
from app.ingest.chunker import Chunk
from app.services import embedding


# ---------- 风险点 7：维度校验 ----------

def test_embed_texts_rejects_wrong_dimension():
    """embedding.py:46：len(v) != settings.embed_dim 必须抛 EmbeddingError。"""
    from app.config import settings

    fake_response = mock.MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]  # 3 维 != 1024
    }
    fake_client = mock.MagicMock()
    fake_client.post.return_value = fake_response
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = fake_client

    with mock.patch.object(embedding, "settings") as s:
        s.embed_enabled = True
        s.embed_base = "http://embed:8088/v1"
        s.embed_api_key = "k"
        s.embed_model = "jina"
        s.embed_dim = 1024  # 与 DDL 一致
        with mock.patch.object(
            embedding.httpx, "Client", return_value=ctx,
        ):
            with pytest.raises(embedding.EmbeddingError, match="维度不符"):
                embedding.embed_texts(["hello"])


def test_embed_texts_accepts_correct_dimension():
    """1024 维通过校验、返回向量（确认阈值没有把合法维度也拒掉）。"""
    from app.config import settings

    good_vec = [0.0] * 1024
    fake_response = mock.MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "data": [{"index": 0, "embedding": good_vec}]
    }
    fake_client = mock.MagicMock()
    fake_client.post.return_value = fake_response
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = fake_client

    with mock.patch.object(embedding, "settings") as s:
        s.embed_enabled = True
        s.embed_base = "http://embed:8088/v1"
        s.embed_api_key = "k"
        s.embed_model = "jina"
        s.embed_dim = 1024
        with mock.patch.object(
            embedding.httpx, "Client", return_value=ctx,
        ):
            out = embedding.embed_texts(["hello"])
    assert len(out) == 1 and len(out[0]) == 1024


def test_embed_texts_disables_when_no_key():
    """embed_enabled=False（无 key）直接抛错，不发请求。"""
    with mock.patch.object(embedding, "settings") as s:
        s.embed_enabled = False
        with pytest.raises(embedding.EmbeddingError, match="EMBED_API_KEY 未配置"):
            embedding.embed_texts(["x"])


def test_vec_literal_shape():
    """pgvector 字面量形如 '[0.1,0.2,...]'，配合 %s::vector。"""
    lit = embedding.vec_literal([0.5, 1.5])
    assert lit == "[0.500000,1.500000]"
    assert lit.startswith("[") and lit.endswith("]")


# ---------- 风险点 1：入库幂等（DELETE + ON CONFLICT） ----------

def test_ingest_document_idempotent_delete_then_write():
    """重复处理同一 doc：主路径先 DELETE FROM chunks WHERE doc_id=? 再写。

    用 mock 掉 DB 事务/解析/向量，断言 SQL 调用顺序：
    1) SELECT doc
    2) UPDATE status=parsing
    3) UPDATE status=chunking + DELETE chunks
    4) executemany INSERT ... ON CONFLICT (doc_id, seq) DO UPDATE
    5) UPDATE status=ready
    """
    from app.ingest import chunker

    fake_doc = mock.MagicMock()
    fake_doc.__getitem__ = lambda self, k: {
        "id": "d1", "title": "t", "source_type": "text",
        "storage_path": "", "ext": {"content": "x" * 320},
    }[k]

    conn = mock.MagicMock()
    conn.execute.return_value.fetchone.return_value = fake_doc
    # 让 conn.execute 既能 SELECT 也能 DELETE/UPDATE：用统一的 fetchone
    conn.execute.return_value = mock.MagicMock()
    conn.execute.return_value.fetchone.return_value = fake_doc

    tx_ctx = mock.MagicMock()
    tx_ctx.__enter__.return_value = conn

    # 解析成 1 个 chunk
    fake_chunks = [Chunk(0, "x" * 320, {"offset": 0}, 320)]
    fake_vecs = [[0.1] * 1024]

    with mock.patch.object(pipeline, "tx", return_value=tx_ctx):
        with mock.patch(
            "app.ingest.parsers.registry.parse_plain",
            return_value=([({"offset": 0}, "x" * 320)], {}),
        ):
            with mock.patch(
                "app.ingest.pipeline.chunk_blocks",
                return_value=fake_chunks,
            ):
                with mock.patch.object(
                    pipeline, "embed_texts",
                    return_value=fake_vecs,
                ):
                    pipeline.ingest_document("d1")

    # 收集所有 conn.execute 调用的 SQL
    sqls = [c.args[0] for c in conn.execute.call_args_list if c.args]
    # 关键断言：DELETE 必须先于 INSERT（铁律 7 幂等）
    del_idx = next(
        i for i, s in enumerate(sqls) if s.startswith("DELETE FROM chunks")
    )
    # _write_chunks 里是 `with conn.cursor() as cur: cur.executemany(...)`
    cur = conn.cursor.return_value.__enter__.return_value
    insert_calls = [c for c in cur.executemany.call_args_list]
    assert insert_calls, "应该有 INSERT chunks 的 executemany 调用"
    insert_sql = insert_calls[0].args[0]
    assert "ON CONFLICT (doc_id, seq) DO UPDATE" in insert_sql, \
        f"幂等兜底 ON CONFLICT 缺失:\n{insert_sql}"
    assert del_idx is not None
    # 且 DELETE 在第一次 INSERT 之前
    first_insert_pos = sqls.index(
        next(
            s for s in sqls if "ON CONFLICT" in s or s.startswith("INSERT")
        )
    ) if any("ON CONFLICT" in s or s.startswith("INSERT") for s in sqls) else None
    if first_insert_pos is not None:
        assert del_idx < first_insert_pos, \
            f"铁律 7：DELETE({del_idx}) 必须在 INSERT({first_insert_pos}) 之前"


def test_ingest_document_degraded_path_redeletes_chunks():
    """EMBED_REQUIRED=false 降级路径：先清掉半成品 chunks 再写无向量版。

    这是架构师标注的"可测风险点 8"的连带验证——降级后 embed_model='none'。
    """
    from app.ingest import chunker

    fake_doc = mock.MagicMock()
    fake_doc.__getitem__ = lambda self, k: {
        "id": "d2", "title": "t", "source_type": "text",
        "storage_path": "", "ext": {"content": "y" * 320},
    }[k]

    conn = mock.MagicMock()
    conn.execute.return_value = mock.MagicMock()
    conn.execute.return_value.fetchone.return_value = fake_doc
    tx_ctx = mock.MagicMock()
    tx_ctx.__enter__.return_value = conn

    fake_chunks = [Chunk(0, "y" * 320, {"offset": 0}, 320)]

    with mock.patch.object(pipeline, "tx", return_value=tx_ctx):
        with mock.patch(
            "app.ingest.parsers.registry.parse_plain",
            return_value=([({"offset": 0}, "y" * 320)], {}),
        ):
            with mock.patch(
                "app.ingest.pipeline.chunk_blocks",
                return_value=fake_chunks,
            ):
                with mock.patch.object(
                    pipeline, "embed_texts", side_effect=RuntimeError("embed down"),
                ):
                    with mock.patch.object(
                        pipeline.settings, "embed_required", False,
                    ):
                        pipeline.ingest_document("d2")

    # 降级路径：写入的 chunk 的 model 字段应为 "none"
    cur = conn.cursor.return_value.__enter__.return_value
    insert_calls = [c for c in cur.executemany.call_args_list]
    assert insert_calls, "降级路径也应有 INSERT"
    row_dict = insert_calls[0].args[1][0]
    assert row_dict["model"] == "none", f"降级后 embed_model 应为 'none'，实际 {row_dict['model']}"
    assert row_dict["emb"] is None, "降级后 embedding 列应为 NULL"
    # 且 chunks 表应被二次 DELETE 清掉半成品（主路径一次 + 降级一次 = 至少 2 次）
    delete_calls = [
        c for c in conn.execute.call_args_list
        if c.args and c.args[0].startswith("DELETE FROM chunks")
    ]
    assert len(delete_calls) >= 2, \
        f"幂等铁律：主路径+降级路径共 DELETE chunks >=2 次，实际 {len(delete_calls)}"
