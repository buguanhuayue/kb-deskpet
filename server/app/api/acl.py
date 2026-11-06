"""ACL 显式授权管理（按人 / 按部门）。

背景：`search/sql.py::ACL` 的可见性判定里有一条
`EXISTS (SELECT 1 FROM acl a WHERE a.doc_id = c.doc_id AND ...)`，
但此前**全代码没有任何写入 acl 的路径**，这条支路恒为空——
"显式授权某用户/部门访问某文档"的能力实际不可用（FR-28，P0）。

本模块补上写入路径，并按铁律 1 的精神做权限把关：

- 只有**文档 owner** 或 **admin 角色**能增删查某文档的 ACL；
- 普通用户一律 403，堵死"把自己加进任意文档 acl"的自我提权
  （acl.subject_id 没有外键约束，写入端必须自行把关）；
- 权限判定与业务过滤全部落在 SQL 的 WHERE 里，不做"先查出来再在 Python 里过滤"。

不新增 ORM / 抽象类：一个函数够用就一个函数（铁律 8）。
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.db import get_conn, tx
from app.deps import get_current_user, CurrentUser

router = APIRouter(prefix="/api", tags=["acl"])

# 与 acl 表 DDL 的 CHECK 约束保持一致：subject_type IN ('user','dept')
SUBJECT_TYPES = ("user", "dept")
# 本版只实现读权限；写权限（edit）语义未定义，先不放开
PERMISSIONS = ("read",)

# 授权资格判定：文档 owner 或 admin。
# 只查 documents / users 两张表，不复制 sql.py 的 ACL 常量（铁律 1：常量唯一定义）。
_DOC_RIGHT_SQL = (
    "SELECT d.owner_id, u.role FROM documents d "
    "JOIN users u ON u.id = %(uid)s::uuid "
    "WHERE d.id = %(doc_id)s::uuid"
)

# 授权目标存在性检查。表名按 subject_type 取，SQL 全部写死，不做字符串拼接。
_SUBJECT_EXISTS_SQL = {
    "user": "SELECT 1 FROM users WHERE id = %s::uuid",
    "dept": "SELECT 1 FROM departments WHERE id = %s::uuid",
}


def _norm_uuid(value: object) -> str | None:
    """把客户端传来的 id 标准化成小写 uuid 字符串；非法返回 None。"""
    if value is None:
        return None
    try:
        return str(uuid.UUID(str(value).strip()))
    except (ValueError, AttributeError, TypeError):
        return None


def _norm_doc_id(doc_id: str) -> str:
    """doc_id 非法 uuid 一律按"不存在"处理（404）。

    否则 `%(doc_id)s::uuid` 会在库里抛 invalid input syntax，整条请求变 500。
    """
    normalized = _norm_uuid(doc_id)
    if normalized is None:
        raise HTTPException(404, {"code": "not_found", "message": "文档不存在"})
    return normalized


def _parse_subject(payload: dict) -> tuple[str, str]:
    """校验并取出 (subject_type, subject_id)。

    参数不合法一律 400 —— 这是调用方的问题，与权限无关。
    """
    subject_type = str(payload.get("subject_type") or "").strip()
    if subject_type not in SUBJECT_TYPES:
        raise HTTPException(
            400,
            {"code": "bad_subject_type", "message": "subject_type 只能是 user 或 dept"},
        )
    subject_id = _norm_uuid(payload.get("subject_id"))
    if subject_id is None:
        raise HTTPException(
            400, {"code": "bad_uuid", "message": "subject_id 必须是合法 uuid"}
        )
    return subject_type, subject_id


def _require_doc_rights(conn, doc_id: str, user: CurrentUser) -> None:
    """校验当前用户是否有权管理该文档的 ACL。

    - 文档不存在 → 404（没登录是 401，这里是"登录了但没这资源"）
    - 既不是 owner 也不是 admin → 403（有身份但没权限）
    """
    row = conn.execute(
        _DOC_RIGHT_SQL, {"uid": user.id, "doc_id": doc_id}
    ).fetchone()
    if not row:
        raise HTTPException(404, {"code": "not_found", "message": "文档不存在"})
    if str(row["owner_id"]) != str(user.id) and row["role"] != "admin":
        raise HTTPException(
            403,
            {
                "code": "forbidden",
                "message": "只有文档所有者或管理员可以管理该文档的 ACL",
            },
        )


@router.post("/documents/{doc_id}/acl")
async def grant_acl(
    doc_id: str,
    payload: dict,
    user: CurrentUser = Depends(get_current_user),
):
    """给某人或某部门显式授权读取该文档。"""
    subject_type, subject_id = _parse_subject(payload)
    permission = str(payload.get("permission") or "read").strip()
    if permission not in PERMISSIONS:
        raise HTTPException(
            400, {"code": "bad_permission", "message": "permission 本版只支持 read"}
        )
    doc_id = _norm_doc_id(doc_id)

    with tx() as conn:
        # 先判权限再判目标存在：不给越权用户泄露"目标是否存在"的信息
        _require_doc_rights(conn, doc_id, user)
        exists = conn.execute(
            _SUBJECT_EXISTS_SQL[subject_type], (subject_id,)
        ).fetchone()
        if not exists:
            raise HTTPException(
                404, {"code": "subject_not_found", "message": "授权目标不存在"}
            )
        conn.execute(
            """INSERT INTO acl (doc_id, subject_type, subject_id, permission)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (doc_id, subject_type, subject_id)
               DO UPDATE SET permission = EXCLUDED.permission""",
            (doc_id, subject_type, subject_id, permission),
        )

    return {
        "doc_id": doc_id,
        "subject_type": subject_type,
        "subject_id": subject_id,
        "permission": permission,
    }


@router.delete("/documents/{doc_id}/acl")
async def revoke_acl(
    doc_id: str,
    payload: dict,
    user: CurrentUser = Depends(get_current_user),
):
    """撤销授权。

    幂等：本来就没有这条授权时也返回成功（撤销是清理动作，不该报 404）。
    """
    subject_type, subject_id = _parse_subject(payload)
    doc_id = _norm_doc_id(doc_id)

    with tx() as conn:
        _require_doc_rights(conn, doc_id, user)
        conn.execute(
            "DELETE FROM acl "
            "WHERE doc_id = %s::uuid AND subject_type = %s AND subject_id = %s::uuid",
            (doc_id, subject_type, subject_id),
        )

    return {
        "doc_id": doc_id,
        "subject_type": subject_type,
        "subject_id": subject_id,
        "revoked": True,
    }


@router.get("/documents/{doc_id}/acl")
async def list_acl(doc_id: str, user: CurrentUser = Depends(get_current_user)):
    """列出该文档的显式授权记录（仅 owner / admin 可见）。"""
    doc_id = _norm_doc_id(doc_id)

    with get_conn() as conn:
        _require_doc_rights(conn, doc_id, user)
        rows = conn.execute(
            """SELECT a.subject_type, a.subject_id, a.permission,
                      CASE a.subject_type
                        WHEN 'user' THEN u.name
                        ELSE dp.name
                      END AS subject_name
               FROM acl a
               LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
               LEFT JOIN departments dp ON a.subject_type = 'dept' AND dp.id = a.subject_id
               WHERE a.doc_id = %s::uuid
               ORDER BY a.subject_type, a.subject_id""",
            (doc_id,),
        ).fetchall()

    return {"doc_id": doc_id, "items": [dict(r) for r in rows]}
