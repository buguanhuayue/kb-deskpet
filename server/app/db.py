"""psycopg3 连接池 + 简单事务helper。

不引入 ORM：本项目的 SQL 既要写权限谓词又要写向量/全文混合打分，
手写 SQL 比 ORM 更短也更好审查（见 AGENTS.md 铁律 4）。
"""
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings

pool = ConnectionPool(
    conninfo=settings.database_url,
    min_size=1,
    max_size=8,
    kwargs={"row_factory": dict_row, "autocommit": False},
    open=False,
)


def open_pool() -> None:
    if pool.closed:
        pool.open(wait=True, timeout=30)


def close_pool() -> None:
    pool.close()


@contextmanager
def get_conn():
    open_pool()
    with pool.connection() as conn:
        yield conn


@contextmanager
def tx():
    """提交/回滚由 psycopg 上下文负责。"""
    open_pool()
    with pool.connection() as conn:
        with conn.transaction():
            yield conn
