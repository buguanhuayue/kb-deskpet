import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from app.api import acl, ingest, meta, query
from app.config import settings
from app.db import close_pool, open_pool

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("api")

STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_pool()
    log.info("api 启动 | embed=%s llm=%s", settings.embed_model, settings.llm_model)
    yield
    close_pool()


app = FastAPI(title="kb-deskpet", version="0.1.0", lifespan=lifespan)
app.include_router(ingest.router)
app.include_router(query.router)
app.include_router(meta.router)
app.include_router(acl.router)


@app.get("/")
async def index():
    page = STATIC / "index.html"
    if page.exists():
        return FileResponse(page)
    return {"service": "kb-deskpet", "docs": "/docs", "health": "/api/health"}
