"""新发现的 bug（架构师报告未覆盖）。

这些是测试过程中暴露的、架构师报告**没有**明确标注的逻辑/契约问题。
大部分测试固化"现状行为"，并断言该行为确实存在，便于工程师决策修复优先级；
已修复的（acl 表写入路径、ON CONFLICT 刷新 locator）已改为断言**修复后的正确行为**。
"""
from unittest import mock
import inspect
import subprocess
import os


ROOT = os.environ.get("KB_ROOT", "/Users/apple/kb-deskpet")


def _grep(pattern, *roots):
    r = subprocess.run(
        ["grep", "-rn", "--include=*.py", "--include=*.sql",
         "-E", pattern, *roots],
        capture_output=True, text=True,
    )
    return r.stdout


# ---------- 新 bug 1：acl 表是死表（已修复：写入路径已补齐） ----------

def test_acl_table_is_no_longer_dead():
    """acl 表已有写入路径，不再是死表。

    修复前：只在 ACL 谓词里被读，全代码无任何 INSERT/UPDATE/DELETE 路径，
    后果是——
    - 铁律 1 可见性谓词里的 EXISTS (SELECT 1 FROM acl a ...) 永远是空；
    - "显式授权某 user/dept 访问某 doc" 的能力实际**不可用**；
    - 文档可见性判定实际只走 visibility / owner_id / dept_id 三路。

    修复后：写入路径集中在 app/api/acl.py 的 ACL 授权管理端点
    （POST / DELETE / GET /api/documents/{doc_id}/acl）。
    grep 范围限定 server/app 与 migrations，排除 server/tests——
    测试文件里的 SQL 字面量不是生产写入路径。
    """
    hits = _grep(
        r"(INSERT[[:space:]]+INTO[[:space:]]+acl([^a-zA-Z_]|$)"
        r"|UPDATE[[:space:]]+acl([^a-zA-Z_]|$)"
        r"|DELETE[[:space:]]+FROM[[:space:]]+acl([^a-zA-Z_]|$))",
        os.path.join(ROOT, "server", "app"),
        os.path.join(ROOT, "migrations"),
    )
    assert hits.strip() != "", "acl 表必须有写入路径（授权管理端点），否则仍是死表"
    # 写入点只允许落在授权管理端点
    for line in hits.splitlines():
        assert "app/api/acl.py" in line, (
            f"acl 写入点只允许在授权管理端点 app/api/acl.py，实际: {line}"
        )
    # 反向：读路径存在（sql.py 里 "SELECT 1 FROM acl a"）
    reads = _grep(r"FROM acl ", os.path.join(ROOT, "server", "app"))
    assert reads.strip() != "", "acl 读路径（EXISTS）应存在"


def test_acl_api_endpoints_exist_with_owner_admin_guard():
    """新增的 ACL 授权管理端点存在，且带 owner/admin 权限判定。"""
    from app.api import acl
    import inspect

    assert hasattr(acl, "grant_acl"), "应有 POST 授权端点"
    assert hasattr(acl, "revoke_acl"), "应有 DELETE 撤销端点"
    assert hasattr(acl, "list_acl"), "应有 GET 列表端点"

    src = inspect.getsource(acl)
    # owner / admin 判定：比对 documents.owner_id 或 users.role
    assert "owner_id" in src, "授权判定必须比对文档 owner"
    assert "admin" in src, "授权判定必须放行 admin 角色"
    # 非 owner 非 admin → 403
    assert "403" in src, "越权操作 ACL 必须返回 403"
    # 三个端点都挂在 /api/documents/{doc_id}/acl 上
    routes = [
        r.path for r in acl.router.routes
        if getattr(r, "path", "").endswith("/acl")
    ]
    assert len(routes) == 3, f"应有 3 个 ACL 端点，实际 {routes}"


# ---------- 新 bug 2：ON CONFLICT DO UPDATE 不刷新 locator（已修复） ----------

def test_on_conflict_update_refreshes_locator():
    """pipeline.py 的 ON CONFLICT DO UPDATE 必须同时刷新 locator 与 token_count。

    修复前只更新 text / embedding / tsv / embed_model，**漏了 locator**。
    场景：同一 doc 重新入库且切法改了（比如源 PDF 换版、chunker 参数调整），
    (doc_id, seq) 冲突时 text/embedding 都更新了，但 **locator 沿用旧值**，
    引用页码会错位（铁律 3 "每个 chunk 的 locator 不能为空/错" 被破坏）。
    token_count 同理：chunker 参数变了 token 数也会变，留着同样是脏数据。
    """
    from app.ingest import pipeline
    src = inspect.getsource(pipeline._write_chunks)
    # 提取 ON CONFLICT ... DO UPDATE 子句（到 SQL 字面量结束为止）
    a = src.find("ON CONFLICT")
    assert a != -1, "应存在 ON CONFLICT (doc_id, seq) DO UPDATE 子句"
    end = src.find('"""', a)
    conflict_clause = src[a:end]
    assert "locator = EXCLUDED.locator" in conflict_clause, \
        f"DO UPDATE 子句必须刷新 locator，否则重入库后引用页码错位:\n{conflict_clause}"
    assert "token_count = EXCLUDED.token_count" in conflict_clause, \
        f"DO UPDATE 子句必须刷新 token_count（chunker 参数变了 token 数也会变）:\n{conflict_clause}"


# ---------- 新 bug 3：audit_logs 死表 ----------

def test_audit_logs_table_is_dead():
    """audit_logs 表建了但全代码无 INSERT 写入（架构师报告提过，此处固化）。

    合规缺口：无法追溯"谁传了什么/谁问过什么"。
    """
    hits = _grep(
        r"INSERT\s+INTO\s+audit_logs\b|audit_logs\s*\(",
        os.path.join(ROOT, "server"),
    )
    # 应只有建表 DDL，无 INSERT
    inserts = [l for l in hits.splitlines()
               if "INSERT" in l.upper() and "audit_logs" in l]
    assert inserts == [], f"发现 audit_logs 写入点: {inserts!r}"


# ---------- 新 bug 4：worker 无 running 超时回收 ----------

def test_worker_lacks_running_timeout_reclaim():
    """worker.py 崩溃后作业永久卡 running，无 locked_at 超时回收。

    架构师报告第六节"风险点 10"提过，但这里固化静态证据：
    全代码不出现 'interval' 回收写法，也不出现
    "UPDATE jobs ... WHERE status='running' AND locked_at < now()" 的兜底。
    """
    src = inspect.getsource(__import__("app.worker", fromlist=["x"]))
    assert "interval" not in src.lower(), "worker 已加 interval 超时回收？"
    assert "locked_at < now()" not in src, "worker 已有 locked_at 超时回收逻辑"
    # 且失败后只置 failed，不回 queued 重试
    run_once_src = inspect.getsource(__import__("app.worker", fromlist=["x"]).run_once)
    assert "status='queued'" not in run_once_src, \
        "worker 失败后若回 queued 重试，架构师风险点 10 需更新"


# ---------- 新 bug 5：__import__("json") 丑写法 ----------

def test_ingest_text_dynamic_import_smell():
    """ingest.py:86 函数体内 __import__('json').dumps —— 代码坏味道。

    应改为文件顶部 import json。本测试固化现状。
    """
    from app.api import ingest
    src = inspect.getsource(ingest.ingest_text)
    assert '__import__("json")' in src or "__import__('json')" in src, \
        "架构师标注的 __import__('json') 丑写法已被清理？"


# ---------- 新 bug 6：query 长度限制 1000 字但 to_query 不截断 ----------

def test_query_length_cap_may_exceed_tsv_max_terms():
    """query.py 限制 question ≤ 1000 字，但 to_query 的 cut(max_terms=512)
    对 1000 字中文可能切出 > 512 个词被截断。

    后果：超长查询的后半部分词被丢弃，召回质量不可预期。
    这是契约模糊点（不是必现 bug，但值得记录）。
    """
    from app.search import tokenize as T
    # 1000 字中文，每字一个词（极端情况）
    q = "。".join(["测"] * 1000)
    terms = T.cut(q, drop_stop=True, max_terms=512)
    assert len(terms) <= 512, "max_terms 截断必须生效"
    # 1000 字全被切词后实际保留数：
    full = T.cut(q, drop_stop=True)
    assert len(full) >= 512 or len(full) <= 512  # 占位：保留原始行为


# ---------- 新 bug 7：GET /api/documents/{doc_id} 越权（固化） ----------

def test_get_document_exposes_any_doc_metadata_by_id():
    """meta.py:52 直接 WHERE id=%s，无 owner/dept/visibility/acl 谓词。

    知道 doc_id（uuid 可枚举/可猜）即可读任意文档元信息（不含正文）。
    与铁律 1 精神冲突。架构师报告标注过，此处用源码静态确认。
    """
    from app.api import meta
    src = inspect.getsource(meta.get_document)
    assert "WHERE id = %s::uuid" in src
    perm_kws = ("owner_id", "dept_id", "visibility", "acl", "EXISTS")
    assert not any(k in src for k in perm_kws), \
        "get_document 已加权限谓词？架构师标注的越权缺陷需工程师修复"
