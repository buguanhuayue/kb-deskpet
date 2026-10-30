"""造一个能登录的演示账号：部门 + admin + token。

    python scripts/seed.py
输出里会打印 token，贴到验收台顶部输入框即可。
"""
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import tx  # noqa: E402

DEPT = "综合部"
EMAIL = "admin@local"
NAME = "管理员"


def main() -> int:
    token = secrets.token_urlsafe(24)
    with tx() as conn:
        dept = conn.execute(
            "INSERT INTO departments (name) VALUES (%s) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
            (DEPT,),
        ).fetchone()
        user = conn.execute(
            """INSERT INTO users (name, email, api_token, dept_id, role)
               VALUES (%s, %s, %s, %s, 'admin')
               ON CONFLICT (email) DO UPDATE SET api_token = EXCLUDED.api_token
               RETURNING id""",
            (NAME, EMAIL, token, dept["id"]),
        ).fetchone()
    print("dept :", DEPT, dept["id"])
    print("user :", EMAIL, user["id"])
    print("token:", token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
