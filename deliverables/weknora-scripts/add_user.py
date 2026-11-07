#!/usr/bin/env python3
"""WeKnora 后台加账号脚本（可复用）。

背景：WeKnora 公开注册被禁用（Public registration is disabled, HTTP 403），
新增账号只能直接写库。本脚本把 2026-11-02 那批同事账号的建法固化成一条命令。

命名规则（与既有 9 位同事 + 2026-11-07 组织化修复一致）：
  username        = 姓名拼音
  email           = 拼音@company.local
  workspace 名    = 中文名's Workspace
  tenant_members  = 只有自己的空间 owner（**不再插技术部 10000 admin**）
  organization_tenant_members = 以 editor 加入部门组织
  preferences     = last_active_tenant_id 指向自己的 workspace
  storage_backends = 主backend(legacy_alias=true) + 派生 files backend
  knowledge_bases = 克隆模板库配置，建一个本人同名库
  kb_shares       = 该库以 viewer 共享给部门组织
  password_hash   = 复用模板账号哈希 → 与模板账号同一个"统一密码"

为什么不能再用旧的「双 tenant_members」建法：
  WeKnora 加入组织时会软删 10000 的直接成员行，改由组织成员行承载。
  旧脚本偏偏把这条 10000 admin 行建成 active，于是 resolveLoginTenantID
  校验 last_active_tenant_id 时认为「用户仍在主租户有资格」，每次登录都落到
  技术部主租户；客户端再把主租户里别人建的库当成他的个人空间，默认上传目标
  也会盲选到别人的库上（2026-11-07 zhangzhangyi 事故）。

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
    # docker exec -i 会继承父进程 stdin。psql -c 虽然不需要 stdin，但若调用方
    # 把本脚本通过管道/heredoc 喂给 python3，容器的 psql 会把后续脚本文本
    # 一起吞掉（表现为命令莫名中断）。显式断开 stdin。
    proc = subprocess.run(
        cmd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
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


def resolve_org_id(main_tenant_id: int, explicit: str | None) -> str:
    """找部门组织 id。优先 --org-id，否则按 owner_tenant_id 查库。"""
    if explicit:
        return explicit
    org = query(
        "SELECT id FROM organizations "
        f"WHERE owner_tenant_id = {main_tenant_id} AND deleted_at IS NULL "
        "ORDER BY created_at LIMIT 1;"
    )
    if not org:
        raise UserError(
            f"找不到 owner_tenant_id={main_tenant_id} 的组织。"
            "请先在 WeKnora 里建组织，或用 --org-id 明确指定"
        )
    return org.splitlines()[0].strip()


def resolve_kb_template(template_tenant_id: int, explicit: str | None) -> str:
    """挑一个个人知识库当配置模板（克隆整行，避免逐列手写漏字段）。"""
    if explicit:
        return explicit
    # 优先挑「已以 viewer 共享给组织的正式个人库」，它正是我们要复刻的形态；
    # 模板空间里常有 probe-* 探针库，配置是临时拼的，不适合当模板。
    preferred = query(
        "SELECT kb.id FROM knowledge_bases kb "
        "JOIN kb_shares s ON s.knowledge_base_id = kb.id AND s.deleted_at IS NULL "
        f"WHERE kb.tenant_id = {template_tenant_id} AND kb.deleted_at IS NULL "
        "AND s.permission = 'viewer' ORDER BY kb.created_at LIMIT 1;"
    )
    kb = preferred or query(
        "SELECT id FROM knowledge_bases "
        f"WHERE tenant_id = {template_tenant_id} AND deleted_at IS NULL "
        "ORDER BY created_at LIMIT 1;"
    )
    if not kb:
        raise UserError(
            f"模板空间 {template_tenant_id} 下没有知识库，无法克隆配置。"
            "请用 --kb-template-id 指定一个现有知识库 id"
        )
    return kb.splitlines()[0].strip()


def existing_state(username: str) -> dict:
    """查账号现状。"""
    state = {
        "tenant": None, "user": False, "members": 0, "backends": 0,
        "org": 0, "kbs": 0, "shares": 0, "last_active": ""
    }
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
        state["last_active"] = query(
            "SELECT coalesce(preferences->>'last_active_tenant_id', '') FROM users "
            f"WHERE username = {quote(username)} AND deleted_at IS NULL;"
        ) or ""
        state["org"] = int(
            query(
                "SELECT count(*) FROM organization_tenant_members "
                f"WHERE tenant_id = {tid};"
            ) or 0
        )
        state["kbs"] = int(
            query(
                "SELECT count(*) FROM knowledge_bases "
                f"WHERE tenant_id = {tid} AND deleted_at IS NULL;"
            ) or 0
        )
        state["shares"] = int(
            query(
                "SELECT count(*) FROM kb_shares s "
                "JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id "
                f"WHERE kb.tenant_id = {tid} AND s.deleted_at IS NULL;"
            ) or 0
        )
    return state


def build_sql(
    name: str,
    username: str,
    email: str,
    password_hash: str,
    template_tenant_id: int,
    main_tenant_id: int,
    org_id: str,
    kb_template_id: str,
) -> str:
    """生成建号 SQL（组织化模型）。

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

-- 1) 建独立 workspace + 两个 storage_backend（CTE 传递 id）
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

-- 2) 回填 tenant 的主 backend
UPDATE tenants SET default_storage_backend_id = (
  SELECT id FROM storage_backends
  WHERE tenant_id = tenants.id AND legacy_alias = true AND deleted_at IS NULL LIMIT 1
)
WHERE name = {ws};

-- 3) 建用户，只插自己空间的 owner 成员资格。
--    旧版还插一条 ({main_tenant_id}, admin) 直接成员行：WeKnora 组织化后这行
--    必须软删，否则 resolveLoginTenantID 会把 last_active_tenant_id 锁死在部门
--    主租户，登录后整个空间落错（2026-11-07 事故）。
WITH nu AS (
  INSERT INTO users
    (username, email, password_hash, avatar, tenant_id, is_active,
     created_at, updated_at, deleted_at, can_access_all_tenants,
     preferences, is_system_admin)
  SELECT {quote(username)}, {quote(email)}, {quote(password_hash)}, '',
         (SELECT id FROM tenants WHERE name = {ws} LIMIT 1), true,
         now(), now(), NULL, false, '{{}}'::jsonb, false
  RETURNING id, tenant_id
)
INSERT INTO tenant_members
  (user_id, tenant_id, role, status, invited_by, joined_at, created_at, updated_at, deleted_at)
SELECT nu.id, nu.tenant_id, 'owner', 'active', NULL, now(), now(), now(), NULL
FROM nu;

-- 4) 登录偏好锁到 home workspace，不让服务端按残留的 last_active 去猜
UPDATE users
SET preferences = jsonb_build_object('last_active_tenant_id', tenant_id),
    updated_at = now()
WHERE username = {quote(username)};

-- 5) 组织成员资格：editor，替代旧的部门主租户直接 admin
INSERT INTO organization_tenant_members
  (organization_id, tenant_id, role, representative_user_id, joined_at, created_at, updated_at)
SELECT {quote(org_id)}, u.tenant_id, 'editor', u.id, now(), now(), now()
FROM users u
WHERE u.username = {quote(username)}
  AND NOT EXISTS (
    SELECT 1 FROM organization_tenant_members m
    WHERE m.organization_id = {quote(org_id)} AND m.tenant_id = u.tenant_id
  );

-- 6) 建个人知识库：克隆模板库整行配置，只改归属。
--    没有自己的库时，客户端会去挑别人的库当默认上传目标。
CREATE TEMP TABLE _newkb AS
  SELECT * FROM knowledge_bases
  WHERE id = {quote(kb_template_id)} AND deleted_at IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM _newkb) <> 1 THEN
    RAISE EXCEPTION '模板知识库不可用，终止建号';
  END IF;
END $$;

UPDATE _newkb SET
  id = uuid_generate_v4()::text,
  name = {quote(name)},
  tenant_id = (SELECT id FROM tenants WHERE name = {ws} LIMIT 1),
  creator_id = (SELECT id FROM users WHERE username = {quote(username)}),
  storage_backend_id = (
    SELECT id FROM storage_backends
    WHERE tenant_id = (SELECT id FROM tenants WHERE name = {ws} LIMIT 1)
      AND legacy_alias = true AND deleted_at IS NULL LIMIT 1
  ),
  created_at = now(), updated_at = now(), deleted_at = NULL;

INSERT INTO knowledge_bases SELECT * FROM _newkb;

-- 7) 以 viewer 共享给部门组织，与 9 位同事一致
INSERT INTO kb_shares
  (knowledge_base_id, organization_id, shared_by_user_id, source_tenant_id,
   permission, created_at, updated_at, deleted_at)
SELECT kb.id, {quote(org_id)}, u.id, u.tenant_id, 'viewer', now(), now(), NULL
FROM knowledge_bases kb
JOIN users u ON u.username = {quote(username)}
WHERE kb.tenant_id = u.tenant_id
  AND kb.name = {quote(name)}
  AND kb.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM kb_shares s
    WHERE s.knowledge_base_id = kb.id
      AND s.organization_id = {quote(org_id)}
      AND s.deleted_at IS NULL
  );

COMMIT;
"""


def build_cleanup_sql(username: str) -> str:
    """清理某个账号的全部残留（幂等）。

    先把要删的 id 存进临时表：旧版先 DELETE users 再回查 users.tenant_id 找
    tenant，此时用户行已经没了，tenants 永远删不掉，--cleanup 会留孤儿空间，
    下一次建号就撞唯一约束。
    """
    return f"""
BEGIN;
CREATE TEMP TABLE _del_user AS
  SELECT id, tenant_id FROM users WHERE username = {quote(username)};
CREATE TEMP TABLE _del_kb AS
  SELECT id FROM knowledge_bases WHERE tenant_id IN (SELECT tenant_id FROM _del_user);

DELETE FROM kb_shares WHERE knowledge_base_id IN (SELECT id FROM _del_kb);
DELETE FROM knowledge_bases WHERE id IN (SELECT id FROM _del_kb);
DELETE FROM organization_tenant_members WHERE tenant_id IN (SELECT tenant_id FROM _del_user);
DELETE FROM tenant_members WHERE user_id IN (SELECT id FROM _del_user);
DELETE FROM storage_backends WHERE tenant_id IN (SELECT tenant_id FROM _del_user);
DELETE FROM users WHERE id IN (SELECT id FROM _del_user);
DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM _del_user);
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
    print(f"  直接成员    : {st['members']} 条（应只有 home owner）")
    print(f"  backend     : {st['backends']} 个")
    print(f"  组织成员    : {st['org']} 条（应为 1）")
    print(f"  个人库/共享 : {st['kbs']} 个 / {st['shares']} 条（应为 1 / 1）")
    print(f"  last_active : {st['last_active'] or '未设置（回落 home）'}（应等于 {tid}）")
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
        print(f"  注意：home 以外还有直接成员资格: {row.replace(chr(10), ', ')}（应为空）")


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
    ap.add_argument(
        "--org-id",
        help="部门组织 id（默认按 --main-tenant-id 的 owner_tenant_id 查库）",
    )
    ap.add_argument(
        "--kb-template-id",
        help="克隆哪个知识库的配置（默认取模板空间最早的一个）",
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

        org_id = resolve_org_id(args.main_tenant_id, args.org_id)
        kb_template_id = resolve_kb_template(args.template_tenant, args.kb_template_id)
        sql = build_sql(
            args.name, username, email, ph,
            args.template_tenant, args.main_tenant_id,
            org_id, kb_template_id,
        )

        print(f"姓名      : {args.name}")
        print(f"username  : {username}")
        print(f"email     : {email}")
        print(f"密码      : {pwd_desc}")
        print(f"空间名    : {args.name}'s Workspace")
        print(f"模板空间  : tenant_id={args.template_tenant}")
        print(f"部门空间  : tenant_id={args.main_tenant_id}（{MAIN_TENANT_NAME}）")
        print(f"组织 id   : {org_id}")
        print(f"个人库模板: {kb_template_id}")

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
