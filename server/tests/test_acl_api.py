"""ACL 授权管理端点（app/api/acl.py）的行为测试。

背景：acl 表此前是死表——ACL 谓词里 EXISTS (SELECT 1 FROM acl a ...) 恒为空，
"显式授权"能力（FR-28，P0）实际不可用。本文件固化新写入路径的行为契约，
重点是**防自我提权**：只有文档 owner 或 admin 能改 acl。

DB 全 mock，不连真库（沿用 test_meta.py 的 mock 手法）。
"""
import asyncio
from unittest import mock

import pytest
from fastapi import HTTPException

from app.api import acl
from app.deps import CurrentUser

OWNER_ID = "11111111-1111-1111-1111-111111111111"
ADMIN_ID = "22222222-2222-2222-2222-222222222222"
OTHER_ID = "33333333-3333-3333-3333-333333333333"
DOC_ID = "44444444-4444-4444-4444-444444444444"
SUBJECT_USER_ID = "55555555-5555-5555-5555-555555555555"
SUBJECT_DEPT_ID = "66666666-6666-6666-6666-666666666666"


def _user(user_id: str, role: str = "member") -> CurrentUser:
    return CurrentUser(
        id=user_id,
        email=f"{user_id}@local",
        name="测试用户",
        dept_id=None,
        role=role,
    )


class _Result:
    """模拟 psycopg3 的结果游标。"""

    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = list(rows) if rows is not None else ([] if row is None else [row])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class FakeConn:
    """按 SQL 关键字分派预置结果，并记录所有 execute 调用。"""

    def __init__(self, doc_row=None, subject_row=None, acl_rows=None):
        self.doc_row = doc_row
        self.subject_row = subject_row
        self.acl_rows = acl_rows or []
        self.calls = []  # [(压平后的 SQL, 参数)]

    def execute(self, sql, params=None):
        flat = " ".join(sql.split())
        self.calls.append((flat, params))
        if "FROM documents d" in flat:
            return _Result(self.doc_row)
        if "FROM users WHERE" in flat:
            return _Result(self.subject_row)
        if "FROM departments WHERE" in flat:
            return _Result(self.subject_row)
        if "FROM acl" in flat:
            return _Result(rows=self.acl_rows)
        return _Result()

    def sqls(self, prefix: str) -> list:
        return [(s, p) for s, p in self.calls if s.startswith(prefix)]


def _ctx(conn):
    """把 FakeConn 包成 with 上下文管理器（模拟 app.db.tx / get_conn）。"""
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = conn
    ctx.__exit__.return_value = False
    return ctx


# ---------- 授权（POST） ----------

def test_owner_can_grant_acl():
    """文档 owner 授权成功：INSERT 语句形态与参数都正确。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        result = asyncio.run(
            acl.grant_acl(
                DOC_ID,
                {
                    "subject_type": "user",
                    "subject_id": SUBJECT_USER_ID,
                    "permission": "read",
                },
                user=_user(OWNER_ID),
            )
        )

    assert result["doc_id"] == DOC_ID
    assert result["subject_type"] == "user"
    assert result["subject_id"] == SUBJECT_USER_ID
    assert result["permission"] == "read"

    inserts = conn.sqls("INSERT INTO acl")
    assert len(inserts) == 1, f"应有 1 条 acl INSERT，实际 {conn.calls}"
    sql, params = inserts[0]
    assert "INSERT INTO acl (doc_id, subject_type, subject_id, permission)" in sql
    assert "ON CONFLICT (doc_id, subject_type, subject_id)" in sql
    assert "DO UPDATE SET permission = EXCLUDED.permission" in sql
    # 全部走参数化占位符，不拼用户输入
    assert params == (DOC_ID, "user", SUBJECT_USER_ID, "read")


def test_admin_can_grant_acl_without_being_owner():
    """admin 角色即使不是 owner 也能授权。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "admin"},
        subject_row={"id": SUBJECT_DEPT_ID},
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        result = asyncio.run(
            acl.grant_acl(
                DOC_ID,
                {"subject_type": "dept", "subject_id": SUBJECT_DEPT_ID},
                user=_user(ADMIN_ID, role="admin"),
            )
        )

    assert result["subject_type"] == "dept"
    assert result["permission"] == "read", "permission 缺省应为 read"
    assert len(conn.sqls("INSERT INTO acl")) == 1


def test_non_owner_non_admin_grant_returns_403():
    """普通用户（非 owner 非 admin）授权 → 403，且不得写入。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": OTHER_ID},
                    user=_user(OTHER_ID),
                )
            )

    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "forbidden"
    assert conn.sqls("INSERT INTO acl") == [], "403 时不得写入 acl"


def test_grant_with_invalid_subject_type_returns_400():
    """subject_type 必须是 user/dept（与 DDL CHECK 一致），否则 400。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "group", "subject_id": SUBJECT_USER_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_subject_type"


def test_grant_with_invalid_subject_id_returns_400():
    """subject_id 必须是合法 uuid，否则 400（不把脏数据塞进库）。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": "not-a-uuid"},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_uuid"


def test_grant_with_unsupported_permission_returns_400():
    """本版只支持 read，其他 permission → 400。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {
                        "subject_type": "user",
                        "subject_id": SUBJECT_USER_ID,
                        "permission": "write",
                    },
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_permission"


def test_grant_to_nonexistent_user_returns_404():
    """subject_type='user' 但 user 不存在 → 404。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row=None,
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "subject_not_found"
    assert conn.sqls("INSERT INTO acl") == [], "目标不存在时不得写入 acl"


def test_grant_to_nonexistent_dept_returns_404():
    """subject_type='dept' 但部门不存在 → 404。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row=None,
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "dept", "subject_id": SUBJECT_DEPT_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "subject_not_found"


def test_grant_on_missing_document_returns_404():
    """doc_id 不存在 → 404（不是 403：文档本身没有）。"""
    conn = FakeConn(doc_row=None, subject_row={"id": SUBJECT_USER_ID})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "not_found"
    assert conn.sqls("INSERT INTO acl") == []


def test_grant_permission_check_runs_before_subject_lookup():
    """越权用户不该从报错里探知"授权目标是否存在"：先判权限，再查目标。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row=None,
    )

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OTHER_ID),
                )
            )

    assert exc.value.status_code == 403
    # 权限判定之后不该再查 users 表
    assert not any("FROM users WHERE" in s for s, _ in conn.calls)


# ---------- 撤销（DELETE） ----------

def test_revoke_acl_executes_delete():
    """撤销授权执行 DELETE FROM acl，参数正确。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        result = asyncio.run(
            acl.revoke_acl(
                DOC_ID,
                {"subject_type": "dept", "subject_id": SUBJECT_DEPT_ID},
                user=_user(OWNER_ID),
            )
        )

    assert result["revoked"] is True
    assert result["subject_type"] == "dept"

    deletes = conn.sqls("DELETE FROM acl")
    assert len(deletes) == 1, f"应有 1 条 acl DELETE，实际 {conn.calls}"
    sql, params = deletes[0]
    assert "subject_type = %s" in sql
    assert "subject_id = %s::uuid" in sql
    assert params == (DOC_ID, "dept", SUBJECT_DEPT_ID)


def test_revoke_acl_by_non_owner_returns_403():
    """非 owner 非 admin 撤销授权 → 403，且不得执行 DELETE。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.revoke_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OTHER_ID),
                )
            )

    assert exc.value.status_code == 403
    assert conn.sqls("DELETE FROM acl") == [], "403 时不得删 acl"


# ---------- 列表（GET） ----------

def test_owner_can_list_acl():
    """owner 能列出该文档的授权记录。"""
    conn = FakeConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        acl_rows=[
            {
                "subject_type": "user",
                "subject_id": SUBJECT_USER_ID,
                "permission": "read",
                "subject_name": "张三",
            }
        ],
    )

    with mock.patch.object(acl, "get_conn", return_value=_ctx(conn)):
        result = asyncio.run(acl.list_acl(DOC_ID, user=_user(OWNER_ID)))

    assert result["doc_id"] == DOC_ID
    assert len(result["items"]) == 1
    assert result["items"][0]["subject_type"] == "user"
    assert result["items"][0]["permission"] == "read"
    assert conn.sqls("SELECT a.subject_type") != []


def test_admin_can_list_acl():
    """admin 即使不是 owner 也能列出。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "admin"}, acl_rows=[])

    with mock.patch.object(acl, "get_conn", return_value=_ctx(conn)):
        result = asyncio.run(acl.list_acl(DOC_ID, user=_user(ADMIN_ID, role="admin")))

    assert result["items"] == []


def test_list_acl_forbidden_for_other_users():
    """普通用户不能列 ACL → 403。"""
    conn = FakeConn(doc_row={"owner_id": OWNER_ID, "role": "member"}, acl_rows=[])

    with mock.patch.object(acl, "get_conn", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(acl.list_acl(DOC_ID, user=_user(OTHER_ID)))

    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "forbidden"


def test_list_acl_missing_document_returns_404():
    """文档不存在 → 404。"""
    conn = FakeConn(doc_row=None, acl_rows=[])

    with mock.patch.object(acl, "get_conn", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(acl.list_acl(DOC_ID, user=_user(OWNER_ID)))

    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "not_found"


# ---------- 端点注册与安全约束 ----------

def test_acl_router_registers_three_endpoints():
    """router 必须在 main.py 注册，且三个端点路径一致。

    用 OpenAPI 规格校验（FastAPI 0.162 的 app.routes 里是 _IncludedRouter 包装，
    直接遍历 app.routes 看不到子路由），这也顺带验证了 main.py 没漏注册。
    """
    from app.main import app

    ops = app.openapi()["paths"].get("/api/documents/{doc_id}/acl", {})
    assert sorted(ops.keys()) == ["delete", "get", "post"], (
        f"应有 POST/DELETE/GET 三个 ACL 端点，实际 {sorted(ops.keys())}"
    )


def test_acl_sql_has_no_string_interpolation_of_user_input():
    """所有 SQL 用参数化占位符，禁止把用户输入拼进 SQL 文本。"""
    import inspect

    src = inspect.getsource(acl)
    # 允许 f-string 的只有固定 SQL 片段的拼接检查（当前实现没有）
    assert "f\"SELECT" not in src
    assert "f\"DELETE" not in src
    assert "f\"INSERT" not in src
    # 参数化占位符存在
    assert "%s" in src or "%(uid)s" in src
