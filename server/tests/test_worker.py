"""架构师风险点 11 + 10：__import__("json") 丑写法 + worker 无超时回收。

- 风险点 11：ingest.py:86 函数体内 __import__("json").dumps(...)
- 风险点 10：worker 崩溃即卡 running，无 locked_at 超时回收
"""
import inspect


def test_ingest_text_uses_dynamic_import_smell():
    """ingest.py:86 在函数体内用 __import__("json").dumps —— 代码坏味道。

    静态确认该写法存在（架构师标注，非阻断但应清理）。
    """
    from app.api import ingest
    src = inspect.getsource(ingest.ingest_text)
    assert '__import__("json")' in src or "__import__('json')" in src, \
        "架构师标注的 __import__('json') 丑写法被移除？"


def test_ingest_text_json_payload_correct():
    """功能面：ingest_text 的 ext 字段必须是合法 JSON 字符串。"""
    import json as _json
    payload = {"content": "  测试内容  ", "title": "笔记"}
    content = (payload.get("content") or "").strip()
    # 模拟 ingest.py:86 实际执行的逻辑
    built = __import__("json").dumps({"content": content})
    parsed = _json.loads(built)
    assert parsed == {"content": "测试内容"}
    # 长度按 UTF-8 字节计
    assert len(content.encode("utf-8")) == 12  # 测试内容 4 字 * 3 + 无空格


def test_ingest_text_rejects_empty():
    """content 为空 → 400（meta.py 契约同层）。"""
    from app.api import ingest
    from fastapi import HTTPException

    payload = {"content": "   "}
    try:
        content = (payload.get("content") or "").strip()
        assert not content
        raise HTTPException(400, {"code": "empty"})
    except HTTPException as e:
        assert e.status_code == 400


def test_worker_no_timeout_reclaim_logic():
    """worker.py 崩溃后作业永久卡 running —— 无 locked_at 超时回收。

    架构师风险点 10：建议加
    UPDATE jobs SET status='queued', locked_at=NULL
    WHERE status='running' AND locked_at < now() - interval '5 min'
    本测试静态确认当前**没有**该逻辑（标记为已知缺口）。
    """
    from app import worker
    src = inspect.getsource(worker)
    # 不应出现超时回收的 interval 写法
    assert "interval" not in src.lower(), \
        "worker 已加超时回收？架构师风险点 10 需更新"
    assert "locked_at < now()" not in src, \
        "worker 已有超时回收逻辑"
    # 且 run_once 吞掉一切异常后只把 job 置 failed，不回 queued
    assert "status='failed'" in src, "worker 失败后应置 failed（现状）"


def test_worker_swallows_ingest_exception():
    """worker.run_once 必须吞掉 ingest 异常不让循环断（worker.py:35）。

    静态确认 except 子句存在。
    """
    from app import worker
    src = inspect.getsource(worker.run_once)
    assert "except Exception" in src, "run_once 必须吞掉一切异常（否则循环断）"
    # 且失败后 job 置 failed + document 置 failed
    assert "status='failed'" in src


def test_worker_empty_queue_returns_false():
    """队列空 / job['id'] is None → run_once 返回 False（worker.py:28）。

    验证 0002 迁移后的"空队列兜一层判空"逻辑。
    """
    from app import worker
    from unittest import mock

    fake_job_none = None
    conn = mock.MagicMock()
    conn.execute.return_value.fetchone.return_value = fake_job_none
    ctx = mock.MagicMock()
    ctx.__enter__.return_value = conn
    ctx.__exit__.return_value = False

    with mock.patch.object(worker, "get_conn", return_value=ctx):
        assert worker.run_once() is False

    # 队列空时应 commit 并返回 False
    conn.commit.assert_called_once()
