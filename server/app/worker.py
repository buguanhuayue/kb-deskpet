"""队列消费者：单进程轮询 claim_job()，一次一条。

WORKER_CONCURRENCY 故意保持 1：向量化是网络 IO 瓶颈，多开只会撞 API 限流。
需要提速就加进程，不要加线程。
"""
import logging
import time

from app.config import settings
from app.db import get_conn, tx
from app.ingest.pipeline import ingest_document

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("worker")

IDLE_SLEEP = 2.0


def run_once() -> bool:
    with get_conn() as conn:
        job = conn.execute("SELECT * FROM claim_job()").fetchone()
        conn.commit()
    if not job:
        return False

    doc_id = str(job["doc_id"])
    log.info("claim job=%s doc=%s attempt=%s", job["id"], doc_id, job["attempts"])
    try:
        ingest_document(doc_id)
    except Exception as e:  # noqa: BLE001 —— worker 必须吞掉一切，否则循环断
        log.exception("doc %s 处理失败", doc_id)
        with tx() as conn:
            conn.execute(
                "UPDATE documents SET status='failed', error_code=%s, error_msg=%s WHERE id=%s",
                (type(e).__name__, str(e)[:800], doc_id),
            )
            conn.execute(
                "UPDATE jobs SET status='failed', error=%s, finished_at=now() WHERE id=%s",
                (str(e)[:800], job["id"]),
            )
    else:
        with tx() as conn:
            conn.execute("UPDATE jobs SET status='done', finished_at=now() WHERE id=%s", (job["id"],))
    return True


def main() -> None:
    log.info("worker 启动，轮询间隔 %.1fs", IDLE_SLEEP)
    while True:
        try:
            if not run_once():
                time.sleep(IDLE_SLEEP)
        except KeyboardInterrupt:
            log.info("worker 退出")
            return
        except Exception:  # noqa: BLE001
            log.exception("轮询异常，2s 后继续")
            time.sleep(IDLE_SLEEP)


if __name__ == "__main__":
    main()
