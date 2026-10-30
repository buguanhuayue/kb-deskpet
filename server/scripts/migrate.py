"""按文件名顺序执行 migrations/*.sql，记录在 schema_migrations。"""
import os
import sys
import time
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def _mig_dir() -> Path:
    """容器里是 /app/migrations（compose 挂载），本机是 <repo>/migrations。

    按候选顺序找第一个存在的目录，找不到就用最后一个（报错时能看出找过哪）。
    """
    here = Path(__file__).resolve()
    candidates: list[Path] = []
    if env := os.environ.get("MIGRATIONS_DIR"):
        candidates.append(Path(env))
    candidates += [here.parents[1] / "migrations", here.parents[2] / "migrations"]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[-1]


MIG_DIR = _mig_dir()


def main() -> int:
    files = sorted(p for p in MIG_DIR.glob("*.sql") if not p.name.startswith("._"))
    if not files:
        print(f"no migration found in {MIG_DIR}")
        return 1

    for attempt in range(30):
        try:
            conn = psycopg.connect(settings.database_url, autocommit=True)
            break
        except psycopg.OperationalError as e:
            print(f"db not ready ({attempt+1}/30): {e}")
            time.sleep(2)
    else:
        return 1

    with conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
        for f in files:
            if f.name in applied:
                print(f"skip  {f.name}")
                continue
            print(f"apply {f.name} ...", end=" ", flush=True)
            conn.execute(f.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations(name) VALUES (%s)", (f.name,))
            print("ok")
    print("migrate done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
