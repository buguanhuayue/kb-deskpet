#!/usr/bin/env python3
"""WeKnora 后台加账号脚本（可复用）。

背景：WeKnora 公开注册被禁用（Public registration is disabled, HTTP 403），
新增账号只能直接写库。本脚本把 2026-11-02 那批同事账号的建法固化成一条命令。

命名规则（与既有 9 位同事一致）：
  username        = 姓名拼音
  email           = 拼音@company.local
  workspace 名=  中文名's Workspace
  tenant_members  = 自己的空间 owner + 技术部 admin
  storage_backends = 主backend(legacy_alias=true) + 派生 files backend
  password_hash   = 复用模板账号哈希 → 与模板账号同一个"统一密码"

用法：
  # 1. 预演，不改任何东西（强烈建议先跑这个）
  python3 add_user.py --name 詹璋毅 --dry-run

  # 2. 真加
  python3 add_user.py --name 詹璋毅

  # 3. 自定义登录名（拼音不好猜时）
  python3 add_user.py --name 詹璋毅 --username zhangzhangyi

  # 4. 换一个模板账号（复用ta 的统一密码）
  python3 add_user.py --name 詹璋毅 --template-user liumingqing

  # 5. 只看现状 / 清理
  python3 add_user.py --name 詹璋毅 --check
  python3 add_user.py --name 詹璋毅 --cleanup

幂等：账号已存在时不会重复建，直接报错退出并提示 --cleanup。
"""

import argparse
import getpass
import os
import subprocess
import sys

# ── WeKnora 部署形态（可用环境变量覆盖）────────────────────────────
CONTAINER = os.environ.get("WKN_PG_CONTAINER", "WeKnora-postgres")
PG_USER = os.environ.get("WKN_PG_USER", "weknora")
PG_DB = os.environ.get("WKN_PG_DB", "weknora")
EMAIL_DOMAIN = os.environ.get("WKN_EMAIL_DOMAIN", "company.local")
MAIN_TENANT_ID = int(os.environ.get("WKN_MAIN_TENANT_ID", "10000"))  # 技术部
MAIN_TENANT_NAME = os.environ.get("WKN_MAIN_TENANT_NAME", "技术部")
DEFAULT_TEMPLATE_USER = os.environ.get("WKN_TEMPLATE_USER", "liumingqing")


class UserError(Exception):
    """参数或环境问题，打印后退出。"""


def run_sql(sql: str, dry_run: bool = False) -> str:
    """在 postgres 容器里执行 SQL，返回输出文本。

    用 docker exec -i + stdin 送 SQL —— 不经过 shell 引号层，
    避免 '詹璋毅''s Workspace' 这类撇号被吃掉。
    """
    if dry_run:
        return "(dry-run 未执行)"

    cmd = [
        "docker", "exec", "-i", CONTAINER,
        "psql", "-U", PG_USER, "-d", PG_DB,
        "-v", "ON_ERROR_STOP=1",
        "-f", "-",
    ]
    proc = subprocess.run(
        cmd, input=sql.encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise UserError("SQL 执行失败：\n" + out)
    return out


def query(sql: str) -> str:
    """只读查询。"""
    cmd = [
        "docker", "exec", "-i", CONTAINER,
        "psql", "-U", PG_USER, "-d", PG_DB,
        "-t", "-A", "-F", "|", "-c", sql,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise UserError(
            "查询失败：\n" + proc.stderr.decode("utf-8", errors="replace")
        )
    return proc.stdout.decode("utf-8", errors="replace").strip()


def quote(value: str) -> str:
    """SQL 字符串字面量转义（单引号翻倍）。"""
    return "'" + value.replace("'", "''") + "'"


def pinyin(name: str) -> str:
    """中文名 → 拼音。优先 pypinyin，退化到常见字表。

    实在转不了就报错让使用者手工给 --username —— 绝不猜错。
    """
    try:
        from pypinyin import lazy_pinyin

        return "".join(lazy_pinyin(name)).lower()
    except ImportError:
        pass

    # 无 pypinyin 时的最小退路：取每个汉字的 ASCII 兜底（几乎不可用，
    # 但至少能给出可读的提示而不是静默生成错误账号）
    ascii_map = {
        "詹": "zhan", "璋": "zhang", "毅": "yi", "刘": "liu", "明": "ming",
        "青": "qing", "李": "li", "中": "zhong", "华": "hua", "张": "zhang",
        "凯": "kai", "铭": "ming", "王": "wang", "晨": "chen", "白": "bai",
        "冰": "bing", "郝": "hao", "鸣": "ming", "李": "li", "高": "gao",
        "峰": "feng", "盛": "sheng", "阳": "yang", "惠": "hui", "嘉": "jia",
        "乐": "le", "国": "guo", "建": "jian", "立": "li", "强": "qiang",
    }
    out = []
    for ch in name:
        if ch.isascii() and ch.isalnum():
            out.append(ch.lower())
        elif ch in ascii_map:
            out.append(ascii_map[ch])
        else:
            raise UserError(
                f"无法自动转拼音（缺 pypinyin 且「{ch}」不在字表里）。\n"
                f"  请装 pypinyin： pip3 install pypinyin\n"
                f"  或直接指定： --username <拼音>"
            )
    return "".join(out)


def resolve_username(name: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        return pinyin(name)
    except UserError:
        raise


def template_hash(template_user: str) -> str:
    """取模板账号的 password_hash —— 复用它= 复用同一个统一密码。"""
    h = query(
        "SELECT password_hash FROM users "
        f"WHERE username = {quote(template_user)} AND deleted_at IS NULL;"
    )
    if not h:
        raise UserError(f"模板账号不存在：{template_user}")
    return h


def existing_state(username: str) -> dict:
    """查账号现状。"""
    state = {"tenant": None, "user": False, "members": 0, "backends": 0}
    row = query(
        "SELECT t.id, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id "
        f"WHERE u.username = {quote(username)} AND u.deleted_at IS NULL;"
    )
    if row:
        tid, tname = row.split("|", 1)
        state["tenant"] = (tid, tname)
        state["user"] = True
        state["members"] = int(
            query(
                "SELECT count(*) FROM tenant_members tm JOIN users u ON u.id = tm.user_id "
                f"WHERE u.username = {quote(username)} AND tm.deleted_at IS NULL;"
            )
            or 0
        )
        state["backends"] = int(
            query(
                "SELECT count(*) FROM storage_backends sb "
                f"WHERE sb.tenant_id = {tid} AND sb.deleted_at IS NULL;"
            )
            or 0
        )
    return state


def build_sql(
    name: str,
    username: str,
    email: str,
    password_hash: str,
    template_tenant_id: int,
    main_tenant_id: int,
) -> str:
    """生成建号 SQL。

    全部用 WITH ... AS (INSERT ... RETURNING)：
    PostgreSQL 是语句级快照，INSERT...SELECT 的子查询看不到同语句刚插入的行，
    必须靠 CTE 把 id 显式传下去。
    """
    ws = quote(f"{name}'s Workspace")
    return f"""
BEGIN;

-- 模板数据落临时表（克隆既有一致配置，避免逐列手写漏字段）
CREATE TEMP TABLE _tpl_tenant AS SELECT * FROM tenants WHERE id = {template_tenant_id};
CREATE TEMP TABLE _tpl_backend AS
  SELECT * FROM storage_backends WHERE tenant_id = {template_tenant_id} AND deleted_at IS NULL;

-- 1) 建独立workspace + 两个 storage_backend（CTE 传递 id）
WITH nt AS (
  INSERT INTO tenants (
    name, description, retriever_engines, status, business, storage_quota, storage_used,
    agent_config, created_at, updated_at, deleted_at, context_config, conversation_config,
    web_search_config, parser_engine_config, storage_engine_config, chat_history_config,
    retrieval_config, credentials, api_principal_config, default_storage_backend_id,
    memory_config, assistant_config, default_settings
  )
  SELECT {ws}, description, retriever_engines, status, business,
         storage_quota, 0, agent_config, now(), now(), NULL, context_config, conversation_config,
         web_search_config, parser_engine_config, storage_engine_config, chat_history_config,
         retrieval_config, credentials, api_principal_config, NULL,
         memory_config, assistant_config, default_settings
  FROM _tpl_tenant
  RETURNING id
)
INSERT INTO storage_backends
  (id, tenant_id, name, provider, config, source, status, legacy_alias, created_at, updated_at)
SELECT gen_random_uuid()::text, nt.id,
       CASE WHEN b.legacy_alias THEN 'System LOCAL'
            ELSE 'System LOCAL files (' || substr(md5(random()::text), 1, 8) || ')' END,
       b.provider, b.config, b.source, b.status, b.legacy_alias, now(), now()
FROM nt
CROSS JOIN (SELECT provider, config, source, status, legacy_alias FROM _tpl_backend) b;

-- 2) 回填 tenant 的主backend
UPDATE tenants SET default_storage_backend_id = (
  SELECT id FROM storage_backends
  WHERE tenant_id = tenants.id AND legacy_alias = true AND deleted_at IS NULL LIMIT 1
)
WHERE name = {ws};

-- 3) 建用户（CTE 传递 id）
WITH nu AS (
  INSERT INTO users
    (username, email, password_hash, avatar, tenant_id, is_active,
     created_at, updated_at, deleted_at, can_access_all_tenants,
     preferences, is_system_admin)
  SELECT {quote(username)}, {quote(email)}, {quote(password_hash)}, '',
         (SELECT id FROM tenants WHERE name = {ws} LIMIT 1), true,
         now(), now(), NULL, false, '{{}}'::jsonb, false
  RETURNING id
)
-- 4) 成员关系：自己的空间 owner + 技术部 admin
INSERT INTO tenant_members
  (user_id, tenant_id, role, status, invited_by, joined_at, created_at, updated_at, deleted_at)
SELECT nu.id, t.tenant_id, t.role, 'active', NULL, now(), now(), now(), NULL
FROM nu
CROSS JOIN (VALUES
  ((SELECT id FROM tenants WHERE name = {ws} LIMIT 1), 'owner'),
  ({main_tenant_id}, 'admin')
) AS t(tenant_id, role);

COMMIT;
"""


def build_cleanup_sql(username: str) -> str:
    """清理某个账号的全部残留（幂等）。"""
    return f"""
BEGIN;
DELETE FROM tenant_members WHERE user_id IN
  (SELECT id FROM users WHERE username = {quote(username)});
DELETE FROM storage_backends WHERE tenant_id IN
  (SELECT id FROM tenants WHERE name IN
     (SELECT t.name FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = {quote(username)}));
DELETE FROM users WHERE username = {quote(username)};
DELETE FROM tenants WHERE name IN
  (SELECT t2.name FROM users u JOIN tenants t2 ON t2.id = u.tenant_id
   WHERE u.username = {quote(username)});
COMMIT;
"""


def show_state(username: str, name: str) -> None:
    st = existing_state(username)
    print(f"\n=== 账号现状：{name}（{username}）===")
    if not st["user"]:
        print("  账号不存在")
        return
    tid, tname = st["tenant"]
    print(f"  workspace   : {tname} (id={tid})")
    print(f"  成员关系    : {st['members']} 条")
    print(f"  backend     : {st['backends']} 个")
    row = query(
        "SELECT tm.role || '@' || t.name FROM tenant_members tm "
        "JOIN tenants t ON t.id = tm.tenant_id "
        "JOIN users u ON u.id = tm.user_id "
        f"WHERE u.username = {quote(username)} AND tm.deleted_at IS NULL ORDER BY tm.role;"
    )
    if row:
        for line in row.splitlines():
            print(f"    - {line}")
    row = query(
        "SELECT t.name FROM tenant_members tm "
        "JOIN tenants t ON t.id = tm.tenant_id "
        "JOIN users u ON u.id = tm.user_id "
        f"WHERE u.username = {quote(username)} AND tm.deleted_at IS NULL "
        "AND t.id <> u.tenant_id;"
    )
    if row:
        print(f"  可见部门空间: {row.replace(chr(10), ', ')}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="WeKnora 后台加账号",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--name", required=True, help="中文姓名，如「詹璋毅」")
    ap.add_argument("--username", help="登录名（默认取拼音）")
    ap.add_argument("--email", help="邮箱（默认 <username>@company.local）")
    ap.add_argument(
        "--template-user",
        default=DEFAULT_TEMPLATE_USER,
        help=f"复用谁的统一密码哈希（默认 {DEFAULT_TEMPLATE_USER}）",
    )
    ap.add_argument(
        "--template-tenant",
        type=int,
        default=10009,
        help="克隆哪个 workspace 的配置（默认 10009 = 刘明青's Workspace）",
    )
    ap.add_argument(
        "--main-tenant-id",
        type=int,
        default=MAIN_TENANT_ID,
        help=f"部门空间的 tenant_id（默认 {MAIN_TENANT_ID} = 技术部）",
    )
    ap.add_argument("--plain-password", help="直接指定明文密码（默认复用模板哈希）")
    ap.add_argument("--dry-run", action="store_true", help="只打印 SQL，不执行")
    ap.add_argument("--check", action="store_true", help="只查现状，不改任何东西")
    ap.add_argument("--cleanup", action="store_true", help="清理该账号的全部残留")
    args = ap.parse_args()

    try:
        username = resolve_username(args.name, args.username)
        email = args.email or f"{username}@{EMAIL_DOMAIN}"

        # ── 只查现状 ──
        if args.check:
            show_state(username, args.name)
            return 0

        # ── 清理残留 ──
        if args.cleanup:
            print(f"清理 {args.name}（{username}）的残留 …")
            run_sql(build_cleanup_sql(username), args.dry_run)
            print("完成。")
            show_state(username, args.name)
            return 0

        # ── 幂等预检 ──
        st = existing_state(username)
        if st["user"]:
            print(f"账号已存在：{username}（workspace={st['tenant'][1]}）")
            print("如需重建请先跑： --cleanup")
            show_state(username, args.name)
            return 1

        # 模板账号哈希
        if args.plain_password:
            try:
                import bcrypt
            except ImportError:
                raise UserError(
                    "用 --plain-password 需要 bcrypt： pip3 install bcrypt"
                )
            ph = bcrypt.hashpw(
                args.plain_password.encode("utf-8"), bcrypt.gensalt(rounds=10)
            ).decode("utf-8")
            pwd_desc = "（新建独立密码）"
        else:
            ph = template_hash(args.template_user)
            pwd_desc = f"（复用 {args.template_user} 的统一密码）"

        sql = build_sql(
            args.name, username, email, ph,
            args.template_tenant, args.main_tenant_id,
        )

        print(f"姓名      : {args.name}")
        print(f"username  : {username}")
        print(f"email     : {email}")
        print(f"密码      : {pwd_desc}")
        print(f"空间名    : {args.name}'s Workspace")
        print(f"模板空间  : tenant_id={args.template_tenant}")
        print(f"部门空间  : tenant_id={args.main_tenant_id}（{MAIN_TENANT_NAME}）")

        if args.dry_run:
            print("\n=== dry-run：以下 SQL 不会执行 ===")
            print(sql)
            return 0

        print("\n执行中 …")
        run_sql(sql)
        print("完成。")
        show_state(username, args.name)
        return 0

    except UserError as e:
        print(f"错误：{e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
