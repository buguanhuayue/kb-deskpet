"""Round 2 独立回归：ACL 授权管理 API 的越权防护 / 契约边界 / 静态 SQL 核对。

背景
----
Round 1（QA 严过关）报了两个 P0：
1. `acl` 表是死表——全代码无 INSERT/UPDATE/DELETE 路径，FR-28「显式 ACL 授权」不可用；
2. `pipeline.py` 的 `ON CONFLICT (doc_id, seq) DO UPDATE` 漏更新 `locator`，破坏铁律 3。

工程师已修复并新增 `app/api/acl.py`（POST / DELETE / GET 三个端点）。
本文件是 QA 在 Round 2 **独立补写**的测试，重点覆盖工程师自测里**没有**的部分：

- 越权防绕过：恶意 payload / 路径参数绕不过权限判定；
- 权限判定顺序（防 uuid 探测）确实成立，而不只是"写在注释里"；
- 工程师自曝的 3 个主张（subject_name / DELETE 幂等 / 判定顺序）的契约边界；
- 真库不可跑时的**静态** SQL 核对（DDL 主键对齐、psycopg3 pyformat 占位符合法性）。

设计原则沿用 `test_acl_api.py`：DB 全 mock，不连真库；断言**行为**而非实现细节。
"""
import asyncio
import ast
import inspect
import os
import re
import subprocess
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

ROOT = os.environ.get("KB_ROOT", "/Users/apple/kb-deskpet")


# ---------------------------------------------------------------- 工具


def _user(user_id: str, role: str = "member") -> CurrentUser:
    return CurrentUser(
        id=user_id,
        email=f"{user_id}@local",
        name="测试用户",
        dept_id=None,
        role=role,
    )


class _Result:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = list(rows) if rows is not None else ([] if row is None else [row])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class RecordingConn:
    """记录每次 execute 的 (SQL, params)，按 SQL 关键字分派预置结果。

    比 `test_acl_api.FakeConn` 多两件事：
    - 保留**调用顺序**（`calls` 是有序列表），用于验证"权限判定先于目标查询"；
    - 暴露 `write_calls()`，用于断言"403 时一条写语句都没执行"。
    """

    def __init__(self, doc_row=None, subject_row=None, acl_rows=None):
        self.doc_row = doc_row
        self.subject_row = subject_row
        self.acl_rows = acl_rows or []
        self.calls = []

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

    # -- 查询辅助 --
    def sqls(self, prefix: str) -> list:
        return [(s, p) for s, p in self.calls if s.startswith(prefix)]

    def write_calls(self) -> list:
        """所有会改数据的语句（INSERT / UPDATE / DELETE）。"""
        verbs = ("INSERT ", "UPDATE ", "DELETE ")
        return [(s, p) for s, p in self.calls if s.upper().startswith(verbs)]

    def all_sql_text(self) -> str:
        return "\n".join(s for s, _ in self.calls)


def _ctx(conn):
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = conn
    ctx.__exit__.return_value = False
    return ctx


def _acl_sql_strings() -> list:
    """抽出 acl.py 里所有会被执行的 SQL 文本。

    用 AST 而不是正则：
    - 正则会被**隐式字符串拼接**骗到（`"DELETE FROM acl " "WHERE ..."` 只抓到前半段）；
    - AST 拿到的是**运行时真值**。

    覆盖两类来源：
    - 模块级常量（`_DOC_RIGHT_SQL` / `_SUBJECT_EXISTS_SQL` 的各条）；
    - 内联传给 `conn.execute(...)` 的字面量（INSERT / DELETE / GET 列表）。
    """
    tree = ast.parse(inspect.getsource(acl))
    out = []

    # 1) 模块级字符串常量
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            value = node.value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                out.append(value.value)
            elif isinstance(value, ast.Dict):
                for v in value.values:
                    if isinstance(v, ast.Constant) and isinstance(v.value, str):
                        out.append(v.value)

    # 2) 内联 conn.execute(<字面量>, ...)
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute"
            and node.args
        ):
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                out.append(first.value)

    return out


# ================================================================
# A. 越权防绕过：恶意输入绕不过权限判定
# ================================================================


def test_non_owner_post_executes_zero_write_statements():
    """非 owner 非 admin 授权 → 403，且**一条写语句都没执行**。

    铁律：`acl.subject_id` 没有外键约束，写入端是唯一的把关口，
    所以 403 分支必须"在写之前就停"，而不是"写了再回滚"。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": OTHER_ID, "permission": "read"},
                    user=_user(OTHER_ID),
                )
            )

    assert exc.value.status_code == 403
    assert conn.write_calls() == [], f"403 时不得执行任何写语句，实际 {conn.write_calls()}"


def test_non_owner_delete_executes_zero_write_statements():
    """非 owner 非 admin 撤销 → 403，零写语句。"""
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
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
    assert conn.write_calls() == []


@pytest.mark.parametrize(
    "bad_type",
    [
        "admin",
        "role",
        "super",
        "all",
        "USER",
        "User",
        "user;",
        "user' OR '1'='1",
        "user')--",
        "../../etc/passwd",
        "",
        "acl",
    ],
)
def test_malicious_subject_type_is_rejected_before_any_sql(bad_type):
    """非法 / 注入型 subject_type 一律 400，且**一条 SQL 都不执行**。

    `subject_type` 决定查 users 表还是 departments 表（`_SUBJECT_EXISTS_SQL` 字典下标），
    若校验不严就可能被用来做 SQL 注入或 KeyError 500。
    """
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": bad_type, "subject_id": SUBJECT_USER_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_subject_type"
    assert conn.calls == [], f"参数非法时不应打库，实际 {conn.calls}"


@pytest.mark.parametrize(
    "bad_permission",
    [
        "write",
        "edit",
        "delete",
        "admin",
        "READ",
        "read' OR '1'='1",
        "read; DROP TABLE acl",
        "all",
    ],
)
def test_malicious_permission_is_rejected_before_any_sql(bad_permission):
    """非 read 的 permission 一律 400，零 SQL。"""
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {
                        "subject_type": "user",
                        "subject_id": SUBJECT_USER_ID,
                        "permission": bad_permission,
                    },
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_permission"
    assert conn.calls == []


@pytest.mark.parametrize(
    "raw_type",
    [" user", "user ", "  user  ", "\tuser\n"],
)
def test_subject_type_is_whitespace_normalized_not_bypassed(raw_type):
    """首尾空白被 strip 后**归一化**到白名单值 —— 这是宽容归一化，不是绕过。

    关键：归一化后的值必须**恰好**等于白名单里的 `user` / `dept`，
    落库的值也因此受 DDL 的 CHECK 约束保护。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        result = asyncio.run(
            acl.grant_acl(
                DOC_ID,
                {"subject_type": raw_type, "subject_id": SUBJECT_USER_ID},
                user=_user(OWNER_ID),
            )
        )

    assert result["subject_type"] == "user", "归一化后必须精确等于白名单值"
    assert result["subject_type"] in acl.SUBJECT_TYPES
    inserts = conn.sqls("INSERT INTO acl")
    assert len(inserts) == 1
    assert inserts[0][1][1] == "user", "落库的 subject_type 必须是归一化后的值"


@pytest.mark.parametrize(
    "bad_subject_id",
    [
        "not-a-uuid",
        "' OR '1'='1",
        "'; DROP TABLE acl; --",
        "../../../etc/passwd",
        "00000000-0000-0000-0000-000000000000' OR '1'='1",
        "",
        "   ",
        None,
        123,
        [],
        {},
    ],
)
def test_malicious_subject_id_is_rejected_before_any_sql(bad_subject_id):
    """非法 subject_id 一律 400，零 SQL（不把脏数据塞进库）。"""
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": bad_subject_id},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "bad_uuid"
    assert conn.calls == []


@pytest.mark.parametrize(
    "bad_doc_id",
    [
        "../../etc/passwd",
        "'; DROP TABLE acl; --",
        "11111111-1111-1111-1111-111111111111' OR '1'='1",
        "1 OR 1=1",
        "not-a-uuid",
        "%2e%2e%2f",
        "",
    ],
)
def test_malicious_doc_id_is_rejected_before_any_write(bad_doc_id):
    """非法 doc_id → 404 not_found，零写语句。

    doc_id 会进 `%(doc_id)s::uuid`；若不做 uuid 校验，PG 会抛 invalid input syntax
    变成 500（而不是 404），且错误信息可能回显用户输入。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                acl.grant_acl(
                    bad_doc_id,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OWNER_ID),
                )
            )

    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "not_found"
    assert conn.write_calls() == [], "doc_id 非法时不得写库"


@pytest.mark.parametrize(
    "payload",
    [
        {"subject_type": "user", "subject_id": "'; DROP TABLE acl; --"},
        {"subject_type": "user'; --", "subject_id": SUBJECT_USER_ID},
        {"subject_type": "user", "subject_id": SUBJECT_USER_ID, "permission": "read'; --"},
        {"subject_type": "dept", "subject_id": "x' UNION SELECT api_token FROM users --"},
    ],
)
def test_user_input_never_appears_in_executed_sql_text(payload):
    """**注入总闸**：用户输入永远不拼进 SQL 文本，只能作为参数出现。

    这是本文件最关键的安全断言：任何把 payload 拼进 SQL 的实现都会在这里翻红。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row={"id": SUBJECT_USER_ID},
    )
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        try:
            asyncio.run(
                acl.grant_acl(DOC_ID, payload, user=_user(OWNER_ID))
            )
        except HTTPException:
            pass  # 400/404 都算"被挡住了"，关键是 SQL 文本干净

    sql_text = conn.all_sql_text()
    for value in payload.values():
        if isinstance(value, str) and len(value) >= 4:
            assert value not in sql_text, (
                f"用户输入 {value!r} 被拼进了 SQL 文本:\n{sql_text}"
            )


def test_subject_type_selects_whitelisted_sql_not_built_from_input():
    """`subject_type` → SQL 的映射必须是白名单字典，不得用输入拼 SQL。

    `_SUBJECT_EXISTS_SQL` 只有 user / dept 两个键，且每条 SQL 都写死。
    """
    assert set(acl._SUBJECT_EXISTS_SQL) == {"user", "dept"}
    for key, sql in acl._SUBJECT_EXISTS_SQL.items():
        assert "users" in sql or "departments" in sql
        # 白名单里的 SQL 里不允许出现任何拼接痕迹（f-string / % / format）
        assert "{" not in sql and "}" not in sql, f"{key} 的 SQL 疑似被拼接"
        assert "%s" in sql, f"{key} 的 SQL 必须用参数化占位符"


def test_doc_rights_sql_is_fully_parameterized_with_named_params():
    """`_require_doc_rights` 的 SQL 必须是具名参数化，且不带任何拼接。"""
    sql = acl._DOC_RIGHT_SQL
    assert "%(uid)s" in sql and "%(doc_id)s" in sql
    assert "%s" not in sql, "具名参数语句里不得混入位置占位符"
    assert "{" not in sql and "}" not in sql, "疑似 f-string 拼接"
    assert ".format" not in sql


def test_all_acl_sql_statements_are_static_strings():
    """acl.py 里所有 conn.execute 的 SQL 都是**字面量常量**（没有变量插值）。"""
    sqls = _acl_sql_strings()
    assert len(sqls) >= 5, f"应至少抽到 5 条 SQL（2 常量 + 2 存在性 + 3 内联），实际 {len(sqls)}"
    for sql in sqls:
        assert "{" not in sql and "}" not in sql, f"疑似拼接的 SQL: {sql!r}"


# ================================================================
# B. 权限判定顺序：防"用 404/200 差异探测 uuid 是否存在"
# ================================================================


def test_rights_check_is_the_very_first_statement_in_post():
    """POST 的**第一条** SQL 必须是权限判定查询。

    若目标存在性查询排在前，越权用户就能用 404(subject_not_found) / 403 的差异
    探测"某个 user/dept uuid 是否存在"。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        subject_row=None,
    )
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        with pytest.raises(HTTPException):
            asyncio.run(
                acl.grant_acl(
                    DOC_ID,
                    {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                    user=_user(OTHER_ID),
                )
            )

    assert conn.calls, "应至少执行了权限判定查询"
    first_sql = conn.calls[0][0]
    assert "FROM documents d" in first_sql, f"第一条 SQL 应是权限判定，实际: {first_sql}"
    assert "owner_id" in first_sql and "role" in first_sql


def test_subject_existence_lookup_never_happens_for_unauthorized_user():
    """越权用户：不查 users、不查 departments（探测面 = 0）。"""
    conn = RecordingConn(
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
    assert not any("FROM users WHERE" in s for s, _ in conn.calls)
    assert not any("FROM departments WHERE" in s for s, _ in conn.calls)


def test_unauthorized_user_cannot_distinguish_existing_vs_missing_subject():
    """越权用户看到的响应**完全一致**（403），与目标是否存在无关。

    这是"权限判定先于目标存在性"的**可观测**证据：
    目标存在 → 403；目标不存在 → 还是 403。
    """
    responses = []
    for subject_row in ({"id": SUBJECT_USER_ID}, None):
        conn = RecordingConn(
            doc_row={"owner_id": OWNER_ID, "role": "member"},
            subject_row=subject_row,
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
        responses.append((exc.value.status_code, exc.value.detail))

    assert responses[0] == responses[1], (
        f"越权用户的响应随目标存在性变化 → 存在 uuid 探测面: {responses}"
    )
    assert responses[0][0] == 403


def test_unauthorized_user_cannot_distinguish_existing_vs_missing_document():
    """越权用户看到的响应**完全一致**（403），与文档是否存在无关。

    文档不存在 → 404；文档存在但不是自己的 → 403。
    这是有意的差异（404 = 资源不存在，403 = 资源存在但无权），属 REST 惯例，
    本测试固化它，防止将来被"优化"成 404 掩盖越权事实。
    """
    conn_missing = RecordingConn(doc_row=None)
    conn_other = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})

    codes = []
    for conn in (conn_missing, conn_other):
        with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(
                    acl.grant_acl(
                        DOC_ID,
                        {"subject_type": "user", "subject_id": SUBJECT_USER_ID},
                        user=_user(OTHER_ID),
                    )
                )
        codes.append(exc.value.status_code)

    assert codes == [404, 403], f"文档存在性差异码被改变: {codes}"
    assert conn_other.write_calls() == []


# ================================================================
# C. 工程师自曝的 3 个主张 —— 复核
# ================================================================


def test_claim1_get_acl_returns_subject_name_via_conditional_left_join():
    """主张 1：GET 列表额外返回 subject_name（LEFT JOIN users / departments）。"""
    sqls = _acl_sql_strings()
    join_sqls = [s for s in sqls if "subject_name" in s]
    assert join_sqls, "GET 列表 SQL 应产出 subject_name"
    sql = join_sqls[0]
    assert "LEFT JOIN users" in sql
    assert "LEFT JOIN departments" in sql
    # 条件 ON：只对 user 类型 join users，只对 dept 类型 join departments
    assert re.search(r"LEFT JOIN users\s+\w+\s+ON\s+a\.subject_type\s*=\s*'user'", sql)
    assert re.search(r"LEFT JOIN departments\s+\w+\s+ON\s+a\.subject_type\s*=\s*'dept'", sql)
    # subject_name 用 CASE 切换两列
    assert "CASE a.subject_type" in sql and "AS subject_name" in sql


def test_claim1_subject_name_is_null_for_orphan_subject():
    """主张 1 的边界：`acl.subject_id` 无外键，目标被删后 LEFT JOIN 出 NULL。

    契约：subject_name 为 null 而不是整条记录消失（否则 owner 看不到"有脏数据"）。
    """
    conn = RecordingConn(
        doc_row={"owner_id": OWNER_ID, "role": "member"},
        acl_rows=[
            {
                "subject_type": "user",
                "subject_id": SUBJECT_USER_ID,
                "permission": "read",
                "subject_name": None,  # 目标已被删除 → LEFT JOIN 结果为 NULL
            }
        ],
    )
    with mock.patch.object(acl, "get_conn", return_value=_ctx(conn)):
        result = asyncio.run(acl.list_acl(DOC_ID, user=_user(OWNER_ID)))

    assert len(result["items"]) == 1
    assert result["items"][0]["subject_name"] is None


def test_claim2_revoke_does_not_probe_subject_existence():
    """主张 2：DELETE **不做**目标存在性检查（允许清理孤儿记录）。

    契约：撤销路径不得查询 users / departments —— 否则"目标已删"的脏 ACL 行
    将永远清不掉（acl.subject_id 无外键，孤儿行是可能的）。
    """
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        asyncio.run(
            acl.revoke_acl(
                DOC_ID,
                {"subject_type": "user", "subject_id": "00000000-0000-0000-0000-000000000000"},
                user=_user(OWNER_ID),
            )
        )

    assert not any("FROM users WHERE" in s for s, _ in conn.calls)
    assert not any("FROM departments WHERE" in s for s, _ in conn.calls)


def test_claim2_revoke_is_idempotent_when_no_record_existed():
    """主张 2：本来没有授权记录时，撤销返回 200 + revoked:true（不是 404）。"""
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
    with mock.patch.object(acl, "tx", return_value=_ctx(conn)):
        result = asyncio.run(
            acl.revoke_acl(
                DOC_ID,
                {"subject_type": "dept", "subject_id": SUBJECT_DEPT_ID},
                user=_user(OWNER_ID),
            )
        )

    assert result["revoked"] is True
    assert result["doc_id"] == DOC_ID
    assert result["subject_type"] == "dept"
    # DELETE 照样执行（幂等清理），只是不因"没记录"而报错
    assert len(conn.sqls("DELETE FROM acl")) == 1


def test_claim2_revoke_still_denies_unauthorized_user():
    """主张 2 的边界：DELETE 幂等 ≠ 任何人可撤。权限判定照旧。"""
    conn = RecordingConn(doc_row={"owner_id": OWNER_ID, "role": "member"})
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
    assert conn.write_calls() == []


def test_claim3_permission_check_precedes_subject_lookup():
    """主张 3：先判权限（403）再判目标存在（404）。"""
    conn = RecordingConn(
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
    assert exc.value.detail["code"] == "forbidden"
    assert conn.calls[0][0].count("FROM documents d") == 1
    assert len(conn.calls) == 1, f"权限判定后不应再发任何查询，实际 {conn.calls}"


# ================================================================
# D. 静态 SQL 核对（真库不可跑时的前置校验）
# ================================================================


def _ddl_acl_table() -> str:
    path = os.path.join(ROOT, "migrations", "0001_init.sql")
    with open(path, encoding="utf-8") as fh:
        sql = fh.read()
    m = re.search(r"CREATE TABLE IF NOT EXISTS acl\s*\((.*?)\n\);", sql, re.S)
    assert m, "migrations/0001_init.sql 里找不到 acl 表定义"
    return m.group(1)


def test_acl_insert_on_conflict_target_matches_ddl_primary_key():
    """INSERT 的 ON CONFLICT 目标必须与 DDL 主键**逐列一致**。

    对不上 = PG 直接报 "there is no unique or exclusion constraint matching
    the ON CONFLICT specification"（真库必炸）。
    """
    ddl = _ddl_acl_table()
    m = re.search(r"PRIMARY KEY\s*\(([^)]*)\)", ddl, re.S)
    assert m, "acl 表 DDL 里找不到 PRIMARY KEY"
    pk_cols = tuple(c.strip() for c in m.group(1).split(","))
    assert pk_cols == ("doc_id", "subject_type", "subject_id"), (
        f"acl 表主键与预期不符: {pk_cols}"
    )

    src = inspect.getsource(acl)
    mo = re.search(r"ON CONFLICT\s*\(([^)]*)\)", src)
    assert mo, "acl.py 里找不到 ON CONFLICT 子句"
    conflict_cols = tuple(c.strip() for c in mo.group(1).split(","))
    assert conflict_cols == pk_cols, (
        f"ON CONFLICT 目标 {conflict_cols} 与 DDL 主键 {pk_cols} 不一致 → 真库会报错"
    )


def test_acl_ddl_subject_id_has_no_foreign_key():
    """现状固化：`acl.subject_id` **没有外键**——这正是写入端必须自查的根本原因。

    若将来补上外键，这条测试会翻红，提示"自我提权风险已从根上消除，
    可以简化 acl.py 的权限判定"。
    """
    ddl = _ddl_acl_table()
    subject_line = re.search(r"subject_id[^\n]*", ddl).group(0)
    assert "REFERENCES" not in subject_line.upper(), (
        f"acl.subject_id 已有外键，权限判定可简化: {subject_line}"
    )


def test_acl_ddl_has_check_constraint_matching_api_whitelist():
    """DDL 的 subject_type CHECK 与 API 的 SUBJECT_TYPES 白名单必须一致。

    不一致 = 某一侧能写入另一侧拒绝的值，或 API 放行 DDL 拒绝的值（500 而非 400）。
    """
    ddl = _ddl_acl_table()
    m = re.search(r"subject_type[^\n]*CHECK\s*\(subject_type\s+IN\s*\(([^)]*)\)\)", ddl)
    assert m, "acl 表 DDL 里找不到 subject_type CHECK 约束"
    ddl_types = tuple(t.strip().strip("'") for t in m.group(1).split(","))
    assert ddl_types == acl.SUBJECT_TYPES, (
        f"DDL 白名单 {ddl_types} 与 API 白名单 {acl.SUBJECT_TYPES} 不一致"
    )


def test_all_acl_sql_parses_with_psycopg3_pyformat():
    """用 psycopg3 自己的 pyformat 解析器校验每条 SQL 的占位符合法。

    这条能在**不连库**的前提下证明 `%(uid)s::uuid` / `%(doc_id)s::uuid`
    具名参数写法被 psycopg3 支持（psycopg3 3.3.8 实测）。
    """
    pytest.importorskip("psycopg")
    try:
        from psycopg._queries import _query2pg
    except ImportError:  # pragma: no cover - 依赖版本差异时跳过
        pytest.skip("psycopg 私有解析器 _query2pg 不可用（psycopg 版本差异）")

    for sql in _acl_sql_strings():
        try:
            _query2pg(sql.encode("utf-8"), "utf8")
        except Exception as exc:  # noqa: BLE001
            raise AssertionError(f"psycopg3 无法解析该 SQL: {sql!r} → {exc}") from exc


def test_psycopg3_rejects_mixing_positional_and_named_placeholders():
    """psycopg3 不允许一条语句里混用 `%s` 与 `%(name)s`（会 ProgrammingError）。

        本项目的 SQL 一律"一条语句一种风格"，此测试固化该约束，防止将来
        在 `_DOC_RIGHT_SQL` 里手滑加一个 `%s` 导致真库 500。
    """
    pytest.importorskip("psycopg")
    from psycopg._queries import _query2pg

    with pytest.raises(Exception):
        _query2pg(b"SELECT %s, %(a)s", "utf8")

    for sql in _acl_sql_strings():
        has_positional = "%s" in sql
        has_named = re.search(r"%\(\w+\)s", sql) is not None
        assert not (has_positional and has_named), f"占位符风格混用: {sql!r}"


# ================================================================
# E. FR-28 / P6 契约（静态）：授权后能被检索到、撤销后不能
# ================================================================


def test_acl_predicate_grants_regardless_of_visibility_level():
    """显式授权必须能覆盖 visibility（private 也能被显式授权对象看到）。

    对应 docs/07 P6「给 C 的部门插 acl 授权后，C 能搜到」与 FR-28。

    ⚠️ 这条断言在 Round 2 首版写成 `S.ACL[S.ACL.find("EXISTS"):]`，
    变异测试（把 `OR EXISTS` 改成 `OR (d.visibility='company' AND EXISTS`）**没被抓到**
    —— 因为切片从 "EXISTS" 开始，正好把变异注入的 visibility 挡在切片之外。
    现在改成：从 EXISTS 往前找所属的 `OR` 分支起点，整条分支一起断言。
    """
    from app.search import sql as S

    exists_at = S.ACL.find("EXISTS")
    assert exists_at != -1, "ACL 谓词里应有 EXISTS 分支"
    # 往前找 EXISTS 所属的那条 OR 分支的起点（rfind 全部 OR，取最后一个）
    or_starts = [m.start() for m in re.finditer(r"\bOR\s+", S.ACL[:exists_at])]
    assert or_starts, "ACL 谓词里应有 OR 分支"
    branch = S.ACL[or_starts[-1]:]

    assert "visibility" not in branch, (
        f"EXISTS 分支仍被 visibility 限制 → private 文档无法被显式授权看到:\n{branch}"
    )
    # 整条分支只看 subject，不看文档可见性
    assert "a.doc_id = c.doc_id" in branch
    assert "a.subject_type = 'user'" in branch
    assert "a.subject_type = 'dept'" in branch
    # 反向自检：ACL 里**其它**分支确实带 visibility —— 证明上面的切片没把
    # visibility 一刀切掉（否则这条断言会变成恒真）
    other = S.ACL[: or_starts[-1]]
    assert "visibility" in other, "切片自检失败：其它分支应带 visibility"


def test_acl_predicate_does_not_filter_on_permission_column():
    """现状固化：ACL 谓词不看 `permission` 列。

    本版只支持 read，所以没影响；但将来放开 write/edit 时，
    这条会翻红，提示"读路径需要区分 permission"。
    """
    from app.search import sql as S

    assert "a.permission" not in S.ACL, "ACL 谓词开始过滤 permission 了，需重审读路径"


def test_retrieve_passes_both_uid_and_dept_into_acl_predicate():
    """检索链路必须同时传 uid 和 dept，否则 ACL 谓词的 dept 分支恒不成立。

    对应 P6：C（另一个部门的用户）靠 `a.subject_id = %(dept)s::uuid` 命中。
    """
    src = inspect.getsource(__import__("app.search.retrieve", fromlist=["x"]).retrieve)
    assert '"uid": uid' in src and '"dept": dept' in src
    # query.py 必须把当前用户的 uid / dept 都传下去
    qsrc = inspect.getsource(__import__("app.api.query", fromlist=["x"]).query)
    assert "uid=user.id" in qsrc and "dept=user.dept_id" in qsrc


# ================================================================
# F. 铁律合规（对照 AGENTS.md）
# ================================================================


def test_acl_constant_not_duplicated_outside_sql_module():
    """铁律 1：ACL 常量只在 `search/sql.py` 一处定义。

    注意用的是**字面量 grep**（不用 -E），避免 BSD grep 正则空转。
    """
    r = subprocess.run(
        ["grep", "-rn", "--include=*.py", "ACL =", os.path.join(ROOT, "server")],
        capture_output=True,
        text=True,
    )
    defs = [
        l
        for l in r.stdout.splitlines()
        if "tests/" not in l and "search/sql.py" not in l
    ]
    assert defs == [], f"ACL 常量在 sql.py 之外被定义: {defs}"


def test_acl_api_has_no_orm_pydantic_or_middleware_abstraction():
    """铁律 8：acl.py 不引入 ORM / pydantic 模型 / 中间件 / 抽象基类。"""
    tree = ast.parse(inspect.getsource(acl))
    assert not [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)], (
        "acl.py 不应定义类（铁律 8：没有第二个实现之前不要抽象）"
    )
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    forbidden = {"sqlalchemy", "pydantic", "sqlmodel", "peewee", "tortoise"}
    assert not (imported & forbidden), f"acl.py 引入了 ORM/pydantic: {imported & forbidden}"
    # 没有 app.middleware / 自建中间件
    assert not any("middleware" in m.lower() for m in imported)


def test_acl_api_does_not_redefine_the_visibility_predicate():
    """acl.py 不得复制 sql.py 的 ACL 可见性谓词字符串（常量唯一定义）。

    只看**代码**，不看模块 docstring——docstring 里为了说明背景会引用
    `EXISTS (SELECT 1 FROM acl a ...)`，那是注释不是常量。
    """
    tree = ast.parse(inspect.getsource(acl))
    # 去掉模块 / 函数 docstring
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                node.body = body[1:] or [ast.Pass()]
    code_only = ast.unparse(tree)

    for marker in ("visibility = 'company'", "owner_id = %(uid)s", "EXISTS ("):
        assert marker not in code_only, (
            f"acl.py 的代码里复制了 sql.py 的可见性谓词片段 {marker!r}（常量唯一定义）"
        )
    # 反向：acl.py 只查 documents/users 两张表的授权资格，不做内容检索
    assert "FROM chunks" not in code_only
