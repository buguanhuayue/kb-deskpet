"""Pytest bootstrap for kb-deskpet server tests.

- Make the server package importable without a venv: put ``server/`` on
  sys.path so ``import app`` resolves.
- Neutralize the module-level psycopg pool so importing ``app.db`` (and
  therefore every module that touches it) does not require a live DB.
  Individual tests monkeypatch the parts they actually exercise.
"""
import sys
from pathlib import Path

import pytest

# server/ directory becomes the package root for `app`
SERVER_DIR = Path(__file__).resolve().parent
ROOT = SERVER_DIR.parent
for p in (SERVER_DIR, ROOT):
    sp = str(p)
    if sp not in sys.path:
        sys.path.insert(0, sp)

# Pre-import app.db so that the ConnectionPool is created with open=False
# (it is, by design) — but we must guard against accidental auto-connect
# if any module pokes it. Replace pool methods with no-ops for tests that
# don't monkeypatch around them.
import app.db as db_mod  # noqa: E402


class _DummyPool:
    """Stands in for ConnectionPool in tests that don't touch the DB."""

    closed = True
    conninfo = "postgresql://test:***@localhost:5433/kb"

    def open(self, *a, **k):
        raise AssertionError("test touched a live pool — should have monkeypatched")

    def close(self, *a, **k):
        pass

    def connection(self):
        raise AssertionError("test touched a live pool — should have monkeypatched")


@pytest.fixture(autouse=True)
def _neutralize_db_pool(monkeypatch):
    monkeypatch.setattr(db_mod, "pool", _DummyPool())
    monkeypatch.setattr(
        db_mod, "open_pool", lambda: None,
    )
    yield


def _dummy_conn(*_args, **_kwargs):
    raise AssertionError("test reached a live DB — patch a fake conn instead")
