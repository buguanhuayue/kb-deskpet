from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.db import get_conn
from app.deps import get_current_user, CurrentUser
from app.search.answer import answer_stream
from app.search.retrieve import retrieve

router = APIRouter(prefix="/api", tags=["query"])


@router.post("/query")
async def query(payload: dict, user: CurrentUser = Depends(get_current_user)):
    question = (payload.get("question") or "").strip()
    if not question:
        raise HTTPException(400, {"code": "empty", "message": "question 不能为空"})
    if len(question) > 1000:
        raise HTTPException(400, {"code": "too_long", "message": "问题超过 1000 字"})

    hits = retrieve(question, uid=user.id, dept=user.dept_id)

    return StreamingResponse(
        answer_stream(question, hits),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/search")
async def search_only(payload: dict, user: CurrentUser = Depends(get_current_user)):
    """只要检索结果，不生成 —— 调参与评测用。"""
    question = (payload.get("question") or "").strip()
    if not question:
        raise HTTPException(400, {"code": "empty", "message": "question 不能为空"})
    hits = retrieve(question, uid=user.id, dept=user.dept_id)
    return {
        "count": len(hits),
        "hits": [
            {
                "doc_id": h.doc_id,
                "title": h.title,
                "text": h.text,
                "locator": h.locator,
                "rrf": round(h.rrf, 4),
                "cosine": round(h.cosine, 4) if h.cosine is not None else None,
                "rerank": round(h.rerank, 4) if h.rerank is not None else None,
            }
            for h in hits
        ],
    }
