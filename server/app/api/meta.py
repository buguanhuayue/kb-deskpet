from fastapi import APIRouter, Depends, HTTPException

from app.config import settings
from app.db import get_conn
from app.deps import get_current_user, CurrentUser

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
async def health():
    try:
        with get_conn() as conn:
            conn.execute("SELECT 1")
        db = "ok"
    except Exception as e:  # noqa: BLE001
        db = f"down: {e}"
    return {
        "db": db,
        "embed": "configured" if settings.embed_enabled else "missing_key",
        "rerank": "configured" if settings.rerank_enabled else "missing_key",
        "llm": "configured" if settings.llm_api_key else "missing_key",
        "embed_model": settings.embed_model,
        "llm_model": settings.llm_model,
    }


@router.get("/me")
async def me(user: CurrentUser = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "dept_id": user.dept_id,
        "role": user.role,
    }


@router.get("/documents")
async def list_documents(user: CurrentUser = Depends(get_current_user)):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT id, title, status, chunk_count, bytes, created_at, error_msg
               FROM documents
               WHERE owner_id = %s OR (dept_id = %s AND visibility <> 'private')
               ORDER BY created_at DESC LIMIT 100""",
            (user.id, user.dept_id),
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@router.get("/documents/{doc_id}")
async def get_document(doc_id: str, user: CurrentUser = Depends(get_current_user)):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, title, status, chunk_count, bytes, created_at, error_code, error_msg, ext "
            "FROM documents WHERE id = %s::uuid",
            (doc_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, {"code": "not_found", "message": "文档不存在"})
    return dict(row)
