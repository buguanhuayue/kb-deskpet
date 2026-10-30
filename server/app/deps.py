from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException

from app.db import get_conn


@dataclass
class CurrentUser:
    id: str
    email: str
    name: str
    dept_id: str | None
    role: str


async def get_current_user(authorization: str = Header(default="")) -> CurrentUser:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, {"code": "no_token", "message": "缺少 Authorization: Bearer <token>"})

    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, email, name, dept_id, role FROM users WHERE api_token = %s",
            (token,),
        ).fetchone()

    if not row:
        raise HTTPException(401, {"code": "bad_token", "message": "token 无效"})

    return CurrentUser(
        id=str(row["id"]),
        email=row["email"],
        name=row["name"],
        dept_id=str(row["dept_id"]) if row["dept_id"] else None,
        role=row["role"],
    )


CurrentUserDep = Depends(get_current_user)
