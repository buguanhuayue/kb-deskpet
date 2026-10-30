import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form

from app.config import settings
from app.db import tx
from app.deps import get_current_user, CurrentUser
from app.services import storage

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

ALLOWED = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
}


@router.post("/file")
async def ingest_file(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    visibility: str = Form(default="dept"),
    user: CurrentUser = Depends(get_current_user),
):
    if not user.dept_id:
        raise HTTPException(400, {"code": "no_dept", "message": "当前账号未分配部门，无法入库"})
    if visibility not in ("private", "dept", "company"):
        raise HTTPException(400, {"code": "bad_visibility", "message": "visibility 只能是 private/dept/company"})

    name = file.filename or "unnamed"
    suffix = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if suffix not in ALLOWED:
        raise HTTPException(415, {"code": "unsupported", "message": f"P0 只支持 pdf/txt/md/csv，收到 {suffix or '未知'}"})

    doc_id = str(uuid.uuid4())
    path, sha, size = storage.save_stream(file.file, doc_id, name)

    if size > settings.max_upload_mb * 1024 * 1024:
        storage.delete(str(path))
        raise HTTPException(413, {"code": "too_large", "message": f"超过 {settings.max_upload_mb}MB"})

    with tx() as conn:
        exists = conn.execute(
            "SELECT id, status FROM documents WHERE dept_id = %s AND sha256 = %s",
            (user.dept_id, sha),
        ).fetchone()
        if exists:
            storage.delete(str(path))
            return {"doc_id": str(exists["id"]), "status": exists["status"], "deduped": True}

        conn.execute(
            """INSERT INTO documents (id, title, source_type, dept_id, owner_id, status,
                                      storage_path, mime, bytes, sha256, visibility)
               VALUES (%s, %s, 'file', %s, %s, 'uploaded', %s, %s, %s, %s, %s)""",
            (doc_id, title or name, user.dept_id, user.id, str(path),
             ALLOWED[suffix], size, sha, visibility),
        )
        conn.execute("INSERT INTO jobs (doc_id, kind) VALUES (%s, 'ingest')", (doc_id,))

    return {"doc_id": doc_id, "status": "uploaded", "bytes": size, "deduped": False}


@router.post("/text")
async def ingest_text(
    payload: dict,
    user: CurrentUser = Depends(get_current_user),
):
    content = (payload.get("content") or "").strip()
    title = (payload.get("title") or "").strip() or f"随手记 {len(content)} 字"
    visibility = payload.get("visibility", "dept")

    if not content:
        raise HTTPException(400, {"code": "empty", "message": "content 不能为空"})
    if not user.dept_id:
        raise HTTPException(400, {"code": "no_dept", "message": "当前账号未分配部门，无法入库"})

    doc_id = str(uuid.uuid4())
    with tx() as conn:
        conn.execute(
            """INSERT INTO documents (id, title, source_type, dept_id, owner_id, status,
                                      ext, visibility, bytes)
               VALUES (%s, %s, 'text', %s, %s, 'uploaded', %s::jsonb, %s, %s)""",
            (doc_id, title, user.dept_id, user.id,
             __import__("json").dumps({"content": content}), visibility, len(content.encode())),
        )
        conn.execute("INSERT INTO jobs (doc_id, kind) VALUES (%s, 'ingest')", (doc_id,))

    return {"doc_id": doc_id, "status": "uploaded"}
