"""架构师风险点 5：ACL 注入（铁律 1）。

- ACL 常量全系统唯一定义在 sql.py。
- 三处注入：HYBRID 向量路 / HYBRID 关键词路 / KEYWORD_ONLY。
- 验证：每条检索 SQL 都确实拼了 ACL 谓词（先过滤后查，不是先查后过滤）。
"""
from app.search import sql as S


def test_acl_defined_exactly_once_in_sql_module():
    """ACL 是 sql.py 的模块级常量，全系统仅此一处定义。"""
    assert hasattr(S, "ACL")
    assert isinstance(S.ACL, str)
    # 谓词里必须含 4 类可见性判定
    assert "visibility = 'company'" in S.ACL
    assert "owner_id = %(uid)s" in S.ACL
    assert "visibility = 'dept'" in S.ACL
    assert "EXISTS" in S.ACL and "FROM acl a" in S.ACL


def test_acl_injected_into_hybrid_vector_path():
    """HYBRID 的向量 CTE (vec) 必须带 ACL。"""
    # 向量路：vec CTE 里 WHERE 子句出现 ACL 的 EXISTS 谓词
    assert S.ACL in S.HYBRID
    # 向量路专属标记
    assert "c.embedding IS NOT NULL" in S.HYBRID


def test_acl_injected_into_hybrid_keyword_path():
    """HYBRID 的关键词 CTE (kw) 也带 ACL（铁律 1 三处之一）。"""
    # 关键词路 CTE 的 ts_rank_cd + @@ q.tsq
    assert "ts_rank_cd(c.tsv, q.tsq)" in S.HYBRID
    # 向量路与关键词路都要拼 ACL —— 数一下 S.HYBRID 里 ACL 出现的次数
    # 至少 2 次（vec + kw）
    assert S.HYBRID.count("visibility = 'company'") >= 2, \
        "HYBRID 的向量路与关键词路都必须各拼一次 ACL"


def test_acl_injected_into_keyword_only_path():
    """KEYWORD_ONLY 也带 ACL。"""
    assert S.ACL in S.KEYWORD_ONLY
    # 无向量路（没有 embedding <=> 谓词）
    assert "embedding <=>" not in S.KEYWORD_ONLY


def test_acl_comes_before_limit_not_after():
    """铁律 1 精神：权限过滤在 WHERE，LIMIT 在 ACL 之后（不是先查 40 条再过滤）。

    验证 SQL 文本里 ACL 谓词在 LIMIT 子句之前。
    """
    for name, sql in (("HYBRID", S.HYBRID), ("KEYWORD_ONLY", S.KEYWORD_ONLY)):
        a = sql.find("visibility = 'company'")
        # 找 CTE 内部的第一个 LIMIT（ACL 同级的 LIMIT）
        lim = sql.find("LIMIT")
        assert a != -1 and lim != -1, f"{name} 缺 ACL 或 LIMIT"
        # ACL 谓词所在的 WHERE 段必须先于同 CTE 的 LIMIT
        # 这里粗粒度断言：ACL 的起始位置 < 第一个 LIMIT 的位置
        # （LIMIT 在 WHERE/ACL 之后才合理）
        assert a < lim, f"{name}: ACL({a}) 必须在 LIMIT({lim}) 之前，否则先查后过滤"


def test_hybrid_scored_capped_at_candidates():
    """RRF 融合候选数 = settings.candidates（铁律 5 的"检索不改顺序"前置）。"""
    # scored CTE 的 LIMIT 用的是 %(cand)s
    assert "LIMIT %(cand)s" in S.HYBRID
    # RRF 公式 1/(k+rnk)
    assert "1.0 / (%(k)s + rnk)" in S.HYBRID


def test_no_or_user_input_in_acl_string():
    """ACL 本身不含任何可被查询词污染的占位符之外的东西。

    安全审查：ACL 只引用 %(uid)s / %(dept)s 两个参数，没有拼接外部输入。
    """
    # 提取 ACL 里的所有 %(... )s 占位符
    import re
    placeholders = set(re.findall(r"%\((\w+)\)s", S.ACL))
    assert placeholders == {"uid", "dept"}, \
        f"ACL 应只引用 uid/dept，实际 {placeholders}"


def test_sql_module_is_sole_acl_source():
    """grep 全仓库：ACL 字符串常量只出现在 sql.py（铁律 1 的唯一性）。

    用静态文本扫描代替 grep，避免依赖外部工具。
    """
    import subprocess
    import os

    root = os.environ.get("KB_ROOT", "/Users/apple/kb-deskpet")
    r = subprocess.run(
        ["grep", "-rn", "--include=*.py", "ACL", os.path.join(root, "server")],
        capture_output=True, text=True,
    )
    # 只允许 sql.py 内定义；其他模块对 ACL 的引用只能是 "S.ACL"/"sql.ACL"
    bad = [
        line for line in r.stdout.splitlines()
        if "ACL" in line
        and "sql.py" not in line
        and "search/sql.py" not in line
        # 放行注释
        and not line.lstrip().startswith("#")
        # 放行 S.ACL / sql.ACL / S.HYBRID 等引用
        and "S.ACL" not in line
        and "sql.ACL" not in line
        # 放行测试文件（我们的测试在引用）
        and "tests/" not in line
        and "ACL =" in line  # 仅看"重新定义"
    ]
    assert not bad, f"ACL 在 sql.py 之外被重新定义: {bad}"


# ---------- acl 表写入路径（已修复：不再是死表） ----------

def test_acl_table_has_write_path_only_in_acl_api():
    """acl 表必须有写入路径，且写入点只落在 ACL 授权管理端点里。

    修复前：全代码 grep 不到 INSERT/UPDATE/DELETE acl，ACL 谓词里的
    EXISTS (SELECT 1 FROM acl a ...) 恒为空——"显式授权"能力实际不存在，
    可见性判定只剩 visibility/owner_id/dept_id 三路（FR-28 是 P0）。

    修复后：写入路径集中在 app/api/acl.py（授权管理端点）。
    grep 范围限定在 server/app 与 migrations，排除 server/tests——
    测试文件里的 SQL 字面量不是生产写入路径。
    """
    import subprocess
    import os

    root = os.environ.get("KB_ROOT", "/Users/apple/kb-deskpet")
    # 搜生产代码对 acl 表的数据修改语句（任何写路径）
    # 正则用 POSIX 字符类而不是 \s / \b：BSD(macOS) 的 grep -E 不认这两个转义，
    # 那样正则永远匹配不到任何东西，断言会变成"空转通过"。
    r = subprocess.run(
        [
            "grep", "-rn", "--include=*.py", "--include=*.sql",
            "-E",
            r"(INSERT[[:space:]]+INTO[[:space:]]+acl([^a-zA-Z_]|$)"
            r"|UPDATE[[:space:]]+acl([^a-zA-Z_]|$)"
            r"|DELETE[[:space:]]+FROM[[:space:]]+acl([^a-zA-Z_]|$))",
            os.path.join(root, "server", "app"), os.path.join(root, "migrations"),
        ],
        capture_output=True, text=True,
    )
    hits = r.stdout.strip()
    assert hits != "", "acl 表必须有写入路径（授权管理端点），否则仍是死表"
    # 写入点只允许出现在授权管理端点里，不得混进检索/入库链路
    for line in hits.splitlines():
        assert "app/api/acl.py" in line, (
            f"acl 写入点只允许在授权管理端点 app/api/acl.py，实际: {line}"
        )
    # 反向确认：读路径存在（EXISTS ... FROM acl a）
    r2 = subprocess.run(
        ["grep", "-rn", "--include=*.py", "FROM acl", os.path.join(root, "server", "app")],
        capture_output=True, text=True,
    )
    assert r2.stdout.strip() != "", "acl 表读路径（EXISTS）应存在"


def test_acl_predicate_only_trusted_owners():
    """安全审查：ACL 谓词里 acl.subject_id 没有外键约束，
    若未来补写入路径，必须防止普通用户自我提权（把自己加进任意 doc 的 acl）。

    写入路径已补齐（app/api/acl.py），因此这条契约由该模块的
    owner/admin 判定落地——本测试固化谓词本身的形态约束。
    """
    from app.search import sql as S
    # ACL 谓词里 acl.subject_type 只接受 'user'/'dept' 两种
    assert "a.subject_type = 'user'" in S.ACL
    assert "a.subject_type = 'dept'" in S.ACL
    # 没有 'admin' 或 'super' 这种隐式提权语义
    assert "super" not in S.ACL.lower()


def test_acl_write_api_enforces_owner_or_admin():
    """写入路径的权限契约：只有文档 owner 或 admin 能改 acl。

    防止普通用户自我提权（把自己加进任意 doc 的 acl）。
    落地在 app/api/acl.py 的 _require_doc_rights。
    """
    from app.api import acl
    import inspect

    src = inspect.getsource(acl)
    assert "owner_id" in src, "授权资格判定必须比对 documents.owner_id"
    assert "'admin'" in src or '"admin"' in src, "授权资格判定必须放行 admin 角色"
    # 非 owner 且非 admin → 403（不是 401：401 是没登录）
    assert "403" in src, "越权访问 ACL 必须返回 403"

