"""本地盘存储抽象（P2 换 MinIO 只改这一个文件）。"""
import hashlib
import logging
import shutil
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


def root() -> Path:
    p = Path(settings.storage_dir)
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise RuntimeError(
            f"STORAGE_DIR={p} 不可用（{e}）。容器内应为 /data/files（compose 已挂卷）；"
            "本机直接调试请设 STORAGE_DIR=./data/files"
        ) from e
    return p


def save_stream(fileobj, doc_id: str, filename: str) -> tuple[Path, str, int]:
    """落盘 + 边写边算 sha256。返回 (路径, sha256, 字节数)。"""
    suffix = Path(filename).suffix.lower()
    target = root() / f"{doc_id}{suffix}"
    h = hashlib.sha256()
    size = 0
    with target.open("wb") as f:
        while True:
            buf = fileobj.read(1024 * 1024)
            if not buf:
                break
            h.update(buf)
            size += len(buf)
            f.write(buf)
    return target, h.hexdigest(), size


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for buf in iter(lambda: f.read(1024 * 1024), b""):
            h.update(buf)
    return h.hexdigest()


def delete(path: str | None) -> None:
    """删文件失败只记日志，绝不因此让入库请求失败（去重/回滚路径都调它）。"""
    if not path:
        return
    p = Path(path)
    try:
        if p.exists():
            p.unlink()
    except OSError as e:
        logger.warning("临时文件删除失败（不影响请求）: %s %s", p, e)


def copy_in(src: Path, doc_id: str) -> Path:
    target = root() / f"{doc_id}{src.suffix}"
    shutil.copyfile(src, target)
    return target
