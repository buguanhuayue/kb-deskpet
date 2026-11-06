"""架构师风险点 9：GET /api/documents/{doc_id} 越权（缺 ACL）。

meta.py:52 直接 WHERE id=%s，不带任何 visibility/owner/dept/acl 谓词。
本测试验证该接口**确实缺少权限过滤**（安全缺陷），并对照 list_documents
证明列表接口是有权限谓词的——凸显详情接口的不一致。
"""
from unittest import mock


def test_get_document_sql_lacks_acl_predicate():
    """meta.py:52 的 SQL 应含 owner/dept/visibility/acl 谓词，但实际没有。

    这是架构师标注的安全缺陷：知道 doc_id 即可读任意文档元信息。
    """
    from app.api import meta
    import inspect

    src = inspect.getsource(meta.get_document)
    # get_document 的 SQL 由两个相邻字符串字面量拼成（select 字段 + WHERE），
    # 直接取整个函数源码做子串判定。
    sql_text = src
    assert "WHERE id = %s::uuid" in sql_text, \
        "get_document 应是 SELECT ... WHERE id = %s::uuid"
    # 安全缺陷断言：以下任一权限谓词缺失即为越权
    has_perm = any(
        kw in sql_text
        for kw in ("owner_id", "dept_id", "visibility", "acl", "EXISTS")
    )
    assert not has_perm, (
        "GET /api/documents/{doc_id} 若已加权限谓词则不再是越权；"
        f"当前函数源码含权限关键字——架构师标注的越权缺陷需被工程师修复"
    )
    # 仅 WHERE id 一个过滤条件
    where_terms = sql_text[sql_text.find("WHERE id"):]
    assert "owner_id" not in where_terms and "visibility" not in where_terms


def test_list_documents_has_acl_unlike_get():
    """对照组：list_documents(meta.py:45) 带了 owner+dept 谓词。

    证明团队对权限过滤是有意识的，唯独漏了详情接口——
    凸显这是遗漏而非有意设计。
    """
    from app.api import meta
    import inspect

    src = inspect.getsource(meta.list_documents)
    assert "owner_id = %s" in src, "list_documents 应含 owner 谓词"
    assert "dept_id = %s" in src, "list_documents 应含 dept 谓词"
    assert "visibility" in src, "list_documents 应含 visibility 判定"


def test_get_document_returns_404_when_missing():
    """功能面：查不到 doc 应 404（非权限逻辑，确认基本契约）。"""
    from app.api import meta
    import asyncio

    class FakeRow:
        def dict(self):
            return {"id": "d", "title": "t"}

    fake_conn = mock.MagicMock()
    fake_conn.execute.return_value.fetchone.return_value = None
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = fake_conn
    ctx.__exit__.return_value = False

    with mock.patch.object(meta, "get_conn", return_value=ctx):
        user = mock.MagicMock()

        async def call():
            return await meta.get_document("missing", user=user)

        from fastapi import HTTPException
        try:
            asyncio.run(call())
            raise AssertionError("应抛出 404")
        except HTTPException as e:
            assert e.status_code == 404
