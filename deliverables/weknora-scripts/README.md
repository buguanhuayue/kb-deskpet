# WeKnora 加账号脚本

`add_user.py` —— WeKnora 后台批量加账号的可复用工具。

## 为什么需要它

WeKnora 的公开注册被禁用（`POST /api/v1/auth/register` 返回
`{"error":{"code":1002,"message":"Public registration is disabled"}}`，HTTP 403），
所以新增账号**只能直接写库**。这个脚本把 2026-11-02 那批同事账号的建法固化下来，
避免每次都手工拼 SQL、每次都踩同样的坑。

## 命名规则（与既有 9 位同事一致）

| 项 | 规则 | 例（詹璋毅） |
|---|---|---|
| `username` | 姓名拼音 | `zhangzhangyi` |
| `email` | 拼音@company.local | `zhangzhangyi@company.local` |
| workspace 名 | `中文名's Workspace` | `詹璋毅's Workspace` |
| `tenant_members` | **只有**自己空间的 `owner` | 1 条 |
| `organization_tenant_members` | 以 `editor` 加入部门组织 | 1 条 |
| `users.preferences` | `last_active_tenant_id` = 自己的 workspace | `10024` |
| `storage_backends` | 主backend（`legacy_alias=true`，名 `System LOCAL`）+ 派生 `System LOCAL files (8位hex)` | 2 个 |
| `knowledge_bases` | 克隆模板库配置，建一个本人同名库 | `詹璋毅` |
| `kb_shares` | 该库以 `viewer` 共享给部门组织 | 1 条 |
| `password_hash` | 复用模板账号哈希 → **同一个统一密码** | 复用 `liumingqing` |

## 为什么必须走组织模型

WeKnora 把用户加入组织时，会**软删** `tenant_members` 里部门主租户（10000）
的直接成员行，改用 `organization_tenant_members` 承载成员资格。旧脚本照抄
2026-11-02 那批账号的建法，把这条 10000 `admin` 行建成了 active，结果：

1. `service/user.go` 的 `resolveLoginTenantID` 校验 `last_active_tenant_id` 时
   只认 `tenant_members` 的 active 行 → 那条没软删的行让偏好锁死在 10000；
2. 每次登录都落进技术部**主租户**，侧栏显示「技术部」而不是本人的 workspace；
3. 客户端 `/knowledge-bases` 返回主租户的全部库，把别人建的 `lgf` 当成他的
   「个人空间」，还把它选成默认上传目标（2026-11-07 实测事故）；
4. 同时缺组织成员行，`kb_shares` 的组织共享授权判定又不一致。

脚本现在一次建齐「组织成员 + home 偏好 + 个人库 + viewer 共享」，
`tenant_members` 只保留 home owner，与其余 9 位同事完全一致。

## 用法

```bash
cd ~/weknora-scripts

# 1. 预演（不改任何东西，强烈建议先跑）
python3 add_user.py --name 张三 --dry-run

# 2. 真加
python3 add_user.py --name 张三

# 3. 登录名不好猜时手工指定
python3 add_user.py --name 张三 --username zhangsan

# 4. 换个人当"统一密码"模板
python3 add_user.py --name 张三 --template-user liumingqing

# 5. 只看现状 / 清理残留
python3 add_user.py --name 张三 --check
python3 add_user.py --name 张三 --cleanup
```

### 常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--name` | 必填 | 中文姓名 |
| `--username` | 拼音 | 登录名（自动转拼音失败时报错要求手工给，绝不猜错） |
| `--email` | `<username>@company.local` | 邮箱 |
| `--template-user` | `liumingqing` | 复用谁的统一密码哈希 |
| `--template-tenant` | `10009` | 克隆哪个 workspace 的配置（10009 = 刘明青's Workspace） |
| `--main-tenant-id` | `10000` | 部门空间 id（10000 = 技术部） |
| `--org-id` | 按 `owner_tenant_id` 查库 | 部门组织 id，换部署/多组织时手工指定 |
| `--kb-template-id` | 模板空间最早的一个库 | 克隆哪个知识库的配置来建个人库 |
| `--plain-password` | 无 | 直接给明文密码（需 `pip3 install bcrypt`），不给就复用模板哈希 |
| `--dry-run` | — | 只打印 SQL，不执行 |
| `--check` | — | 只查现状 |
| `--cleanup` | — | 清理该账号全部残留（幂等） |

### 环境变量（换部署形态时用）

`WKN_PG_CONTAINER`（默认 `WeKnora-postgres`）、`WKN_PG_USER`（`weknora`）、
`WKN_PG_DB`（`weknora`）、`WKN_EMAIL_DOMAIN`（`company.local`）、
`WKN_MAIN_TENANT_ID`（`10000`）、`WKN_MAIN_TENANT_NAME`（`技术部`）、
`WKN_TEMPLATE_USER`（`liumingqing`）

## 它根治了哪些坑

写这脚本时踩过的坑，都已在脚本里规避：

1. **PostgreSQL 语句级快照**
   `INSERT INTO tenants ... SELECT ... WHERE name='X'` 的子查询**看不到同一条语句
   刚插入的行**（PG 在语句开始时固定快照），导致后续 insert 关联到上一轮残留的
   tenant 上，唯一约束报 `(tenant_id, name) already exists`。
   → 脚本全部用 `WITH nt AS (INSERT ... RETURNING id) INSERT ... SELECT FROM nt`，
   显式把 id 传下去。

2. **多层 shell 转义吃掉撇号**
   `ssh → bash → psql` 三层传递 `'詹璋毅''s Workspace'`，撇号会被吃掉变成
   `詹璋毅s Workspace`（少了撇号，与其他同事命名不一致）。
   → 脚本是 Python，SQL 通过 `docker exec -i` 的 stdin 送进容器，
   **完全不经过 shell 引号层**。

3. **`psql -v ON_ERROR_STOP=1` 不会回滚已提交的事务**
   psql 每条语句独立事务，前面 COMMIT 过的内容不会因为后面报错而回滚，
   会留下半成品（孤儿 tenant / backend）。
   → 脚本用单事务 `BEGIN/COMMIT` + `ON_ERROR_STOP`，配合预检与幂等清理：
   账号已存在时拒绝创建并提示 `--cleanup`。

4. **半组织化账号**
   见上面「为什么必须走组织模型」：只插老式双 `tenant_members` 会让账号落到
   部门主租户、把别人的库当个人空间。→ 脚本一次建齐四件套，`--check` 会把
   组织成员 / 个人库 / 共享 / `last_active` 全打印出来，少一样一眼能看见。

5. **`--cleanup` 留孤儿空间**
   旧版先 `DELETE users` 再回查 `users.tenant_id` 找 tenant，用户行已经没了，
   `tenants` 永远删不掉，下次建号撞唯一约束。
   → 先把待删 id 存进临时表，再按依赖顺序删，并连带清理
   `organization_tenant_members` / `kb_shares` / `knowledge_bases`。

另外：账号已存在时脚本**不会重复创建**，直接退出并提示清理命令。

## 前置条件

- 能 `docker exec` 进 postgres 容器（脚本靠这个执行 SQL）
- Python 3.9+（虚拟机上是 3.x）
- 装了 `pypinyin` 才能自动转拼音（`pip3 install pypinyin`）；
  没装也能用内置的小字表兜底（覆盖现有 9 位同事的姓），
  实在转不了会报错要求 `--username`，**不会静默生成错误账号**

## 加完账号后

先跑 `python3 add_user.py --name 张三 --check`，确认：

- 直接成员 1 条、组织成员 1 条、个人库 1 个 / 共享 1 条
- `last_active` 等于 workspace id
- 没有「home 以外还有直接成员资格」的警告

然后让客户端**完全退出并重新登录**（不是只关面板）：本地 `deskpet_cfg_v2`
里的 `homeTenantId` 沿用上一次登录的租户，不重登会把上传发到错误租户并触发 403。

账号建好只是第一步，密码沿用"统一密码"（复用模板账号的 bcrypt 哈希）。
要单独设密码：

```bash
# 改密码（在能连库的机器上执行，$2a$ 前缀是 bcrypt）
docker exec -i WeKnora-postgres psql -U weknora -d weknora -c \
  "UPDATE users SET password_hash='<bcrypt哈希>' WHERE username='zhangzhangyi';"
```

或用脚本的 `--plain-password` 重建（会连带覆盖密码）。
