# kb-deskpet Round 2 · 独立回归验证报告（ACL API + ON CONFLICT 修复）

> 测试/验证 · 仅写测试不改业务代码
> 仓库：`/Users/apple/kb-deskpet` ｜ 对象：`server/app/api/acl.py`（新增）、`server/app/ingest/pipeline.py`
> 生成日期：2026-11-06 ｜ 测试人：严过关（Yan）· QA
> 上游：工程师（寇豆码）修复说明 ｜ 前序：`kb-deskpet-test-report-2026-11-06.md`（Round 1）

---

## TL;DR

| 项 | 结果 |
|---|---|
| 全量 pytest（独立跑） | **152 passed / 0 failed / 0 skipped**（工程师 80 + QA 新增 72） |
| 变异测试 | **15 个变异体，15 个全部被捕获**（含 1 个 QA 自己写出的恒真断言，已当场修掉） |
| 发现的新问题 | **0 个 P0/P1 缺陷**；1 个 P2 测试质量问题（`test_audit_logs_table_is_dead` 仍空转） |
| 3 个自曝主张 | **3 个全部接受**（其中第 2 条我原本怀疑，结论是**必须接受**，理由见第四节） |
| 铁律合规 | 铁律 1 ✅ / 铁律 3 ✅ / 铁律 8 ✅ / `sql.py::ACL` 一字未动 ✅（逐字节比对确认） |
| 真库验证 | ❌ **不可执行**（本机无 docker、无本地 PG、无 pglast）→ 已做静态核对 + 上线前清单 |
| **路由决策** | **Send To → NoOne（修复通过，可进入上线前真库验收）** |

> **本轮的关键产出不是"80 passed"，而是 15 个变异测试全部翻红。**
> 上一轮就栽在"断言恒真"上（见第三节），本轮用变异测试把每个新断言都证明了一遍。

---

## 一、实际 pytest 结果（QA 独立执行，未采信工程师自述）

```
$ cd /Users/apple/kb-deskpet/server && python3 -m pytest tests/ -v
============================= test session starts ==============================
platform darwin -- Python 3.13.12 -- pytest-9.2.0 -- pluggy-1.7.0
configfile: pyproject.toml
plugins: mock-3.17.0, anyio-4.16.0
collected 152 items
...
============================== 152 passed in 6.66s ==============================
```

| 测试文件 | 用例数 | 归属 |
|---|---|---|
| `test_acl_api_round2.py` | **72** | **QA 本轮新增**（越权防绕过 / 判定顺序 / 静态 SQL 核对） |
| `test_acl_api.py` | 18 | 工程师新增 |
| `test_tokenize.py` | 11 | Round 1 |
| `test_sql.py` | 11 | Round 1（其中 3 条被工程师改成断言"已修复"） |
| `test_answer.py` | 11 | Round 1 |
| `test_new_bugs.py` | 8 | Round 1（其中 2 条被工程师改成断言"已修复"） |
| `test_worker.py` | 6 | Round 1 |
| `test_retrieve.py` | 6 | Round 1 |
| `test_pipeline.py` | 6 | Round 1 |
| `test_meta.py` | 3 | Round 1 |
| **合计** | **152** | 80（工程师）+ 72（QA 新增） |

**结论：80 passed 这个数字属实，QA 独立跑出同样结果，且未发现新的失败。**

---

## 二、变异测试（本轮最重要的一节）

### 2.1 方法

"测试通过"不等于"断言有效"。断言恒真（vacuous）时，代码改坏了测试照样绿。
本轮对**每一条被工程师改成"断言已修复"的测试**，以及**QA 自己新增的每一条关键断言**，
逐一注入缺陷（mutation），确认测试会**翻红**。

方法：
1. 备份原始文件（`/tmp/kbqa_backup/`）+ 用 `git checkout` 二次兜底；
2. 注入一个具体缺陷；
3. 跑对应测试 → **期望 FAIL**；
4. 还原 → 跑全量 → **期望全绿**。

> ⚠️ 过程中踩到两个还原事故，已全部修复并复核（详见 2.4），最终业务代码与
> 工程师交付状态**逐字节一致**（`shasum` 校验 + `git diff` 双重确认）。

### 2.2 工程师改动的 3 条断言 —— 全部有效 ✅

| # | 变异体 | 期望 | 实测 | 捕获它的测试 |
|---|---|---|---|---|
| **M1** | 删掉 `locator = EXCLUDED.locator` | FAIL | **✅ FAIL** | `test_new_bugs.py::test_on_conflict_update_refreshes_locator` |
| **M2** | 删掉 `token_count = EXCLUDED.token_count` | FAIL | **✅ FAIL** | 同上 |
| **M3** | 把 acl 写入路径改名（模拟 acl 表重新变回死表） | FAIL | **✅ FAIL ×3** | `test_sql.py::test_acl_table_has_write_path_only_in_acl_api`、`test_new_bugs.py::test_acl_table_is_no_longer_dead`、`test_acl_api.py::test_owner_can_grant_acl` |
| **M5** | 把"目标存在性查询"挪到"权限判定"之前 | FAIL | **✅ FAIL** | `test_acl_api.py::test_grant_permission_check_runs_before_subject_lookup` |
| **M6b** | 删掉 `_require_doc_rights` 的 403 抛错 | FAIL | **✅ FAIL ×4** | `test_non_owner_non_admin_grant_returns_403` 等 4 条 |

M1 的实测输出（节选）：

```
E  AssertionError: DO UPDATE 子句必须刷新 locator，否则重入库后引用页码错位:
E    ON CONFLICT (doc_id, seq) DO UPDATE
E      SET text = EXCLUDED.text, token_count = EXCLUDED.token_count,
E          embedding = EXCLUDED.embedding, tsv = EXCLUDED.tsv,
E          embed_model = EXCLUDED.embed_model
```

> **补充发现**：M1 变异时 `test_pipeline.py` 的 6 条**全部通过**——
> 说明 `ON CONFLICT` 子句的 locator 覆盖**只有 `test_on_conflict_update_refreshes_locator`
> 这一条守卫**。这是单点防御，但该测试已证明有效，可接受。

### 2.3 QA 新增断言的变异测试 —— 全部有效 ✅（含 1 个自查自纠）

| # | 变异体 | 实测 | 捕获它的测试 |
|---|---|---|---|
| **N1** | 删掉 403 抛错（越权可写库） | ✅ FAIL | `test_non_owner_post_executes_zero_write_statements` 等 |
| **N2** | 目标存在性查询提到权限判定之前 | ✅ FAIL | `test_rights_check_is_the_very_first_statement_in_post` |
| **N3** | 给 DELETE 加目标存在性检查 | ✅ FAIL | `test_claim2_revoke_does_not_probe_subject_existence` |
| **N4** | 放开 `subject_type` 白名单 | ✅ FAIL ×12 | `test_malicious_subject_type_is_rejected_before_any_sql` |
| **N5** | 去掉 `doc_id` 的 uuid 校验 | ✅ FAIL | `test_malicious_doc_id_is_rejected_before_any_write` |
| **N6** | `ON CONFLICT` 目标与 DDL 主键不一致 | ✅ FAIL | `test_acl_insert_on_conflict_target_matches_ddl_primary_key` |
| **N7** | ACL 谓词给 EXISTS 分支加 `visibility` 限制 | ✅ FAIL | `test_acl_predicate_grants_regardless_of_visibility_level` |
| **N8** | ACL 谓词开始过滤 `permission` 列 | ✅ FAIL | `test_acl_predicate_does_not_filter_on_permission_column` |
| **N9** | acl.py 复制 sql.py 的 EXISTS 谓词 | ✅ FAIL | `test_acl_api_does_not_redefine_the_visibility_predicate` |
| **N10** | acl.py 引入 sqlalchemy（ORM） | ✅ FAIL | `test_acl_api_has_no_orm_pydantic_or_middleware_abstraction` |
| **N11** | acl.py 定义抽象基类 | ✅ FAIL | 同上 |
| **N12** | 在 sql.py 之外重新定义 `ACL` 常量 | ✅ FAIL ×2 | `test_acl_constant_not_duplicated_outside_sql_module` |
| **N13** | INSERT 把 `doc_id` 拼进 SQL 文本 | ✅ FAIL | `test_user_input_never_appears_in_executed_sql_text` |
| **N14** | 去掉 `permission` 白名单校验 | ✅ FAIL ×9 | `test_malicious_permission_is_rejected_before_any_sql` |
| **N15** | `retrieve()` 不再传 `dept`（P6 用例失效） | ✅ FAIL | `test_retrieve_passes_both_uid_and_dept_into_acl_predicate` |

### 2.4 🔍 自查自纠：QA 自己写出的 1 条恒真断言（已修）

**N7 第一次跑没被抓到。** 根因是我第一版断言写成：

```python
exists_branch = S.ACL[S.ACL.find("EXISTS"):]   # ❌ 切片从 "EXISTS" 开始
assert "visibility" not in exists_branch
```

变异把 `OR EXISTS (` 改成 `OR (d.visibility = 'company' AND EXISTS (`——
而 `visibility` 正好落在 `EXISTS` **之前**，被切片切掉了 → 断言恒真。

**修法**：从 `EXISTS` 往前找所属的 `OR` 分支起点，整条分支一起断言，
并加了一条**反向自检**（其它分支必须带 visibility），防止切片把 visibility 一刀切掉。
修完重跑 N7 → **✅ FAIL**，断言恢复有效。

> **这条自查自纠是本轮最有价值的产出**：它用实证说明——
> **"我写的测试"和"工程师写的测试"一样会变成恒真断言**，
> 所以"变异测试"必须是 QA 的强制动作，不是可选项。

### 2.5 还原事故与最终状态

| 事故 | 原因 | 处置 | 最终确认 |
|---|---|---|---|
| `sql.py` 变异后 `git checkout` 报 `pathspec did not match` | 脚本用了未备份的还原路径 | 脚本在**变异前**就中止 → `sql.py` 从未被改动 | `git show HEAD:...sql.py \| diff -` 逐字节一致 ✅ |
| `acl.py` 变异后 `git checkout` 失败 | **`acl.py` 是未跟踪新文件**，不在 git 里 | 改用 `/tmp/kbqa_backup/acl.py.orig` 还原 | `diff` 逐字节一致 ✅ |

**最终状态校验（双重）**：

```
$ shasum -c /tmp/kbqa_backup/orig.sha256
server/app/ingest/pipeline.py: OK
server/app/api/acl.py: OK

$ git diff --stat
 docs/04-API接口文档.md  | 111 ++++++++++++++++++-
 server/app/ingest/pipeline.py | 6 +-
 server/app/main.py      | 3 +-
（sql.py、acl.py、retrieve.py 均无残留变异）
```

**变异测试做完后重跑全量：152 passed。**

---

## 三、grep 空转问题的影响面评估（macOS BSD grep）

### 3.1 问题确认（QA 独立复现）

```bash
$ printf 'INSERT INTO acl x\n' | grep -E "INSERT\s+INTO\s+acl\b"
（无输出）          # ← BSD grep -E 不认 \s 和 \b
```

| 写法 | macOS BSD grep | 命中数（对真实 acl.py） |
|---|---|---|
| `INSERT\s+INTO\s+acl\b`（旧） | ❌ 不支持 | **0**（假阳性：明明有写入点也报"没有"） |
| `INSERT[[:space:]]+INTO[[:space:]]+acl([^a-zA-Z_]\|$)`（新） | ✅ 支持 | **2**（`acl.py:133` INSERT、`acl.py:164` DELETE） |

**工程师的新断言实测能命中** ✅ —— `grep -rn --include=*.py --include=*.sql -E
"(INSERT[[:space:]]+INTO[[:space:]]+acl([^a-zA-Z_]|$)|UPDATE[[:space:]]+acl([^a-zA-Z_]|$)|DELETE[[:space:]]+FROM[[:space:]]+acl([^a-zA-Z_]|$))"
server/app migrations` → 命中 `server/app/api/acl.py:133` 与 `:164`。

### 3.2 影响面：系统扫描 `server/tests/` 里**所有** grep 调用

`server/tests/` 共 5 处 grep 调用，逐个核对：

| 位置 | 正则 | 是否空转 | 结论 |
|---|---|---|---|
| `test_sql.py:92` `test_sql_module_is_sole_acl_source` | 字面量 `ACL`（无 `-E`） | ❌ 不空转 | ✅ 安全 |
| `test_sql.py:135` `test_acl_table_has_write_path_only_in_acl_api` | POSIX 字符类 | ❌ 不空转 | ✅ 已修，**实测命中 2 处** |
| `test_sql.py:153`（同文件内） | 字面量 `FROM acl` | ❌ 不空转 | ✅ 安全 |
| `test_new_bugs.py:41` `test_acl_table_is_no_longer_dead` | POSIX 字符类 | ❌ 不空转 | ✅ 已修，**实测命中 2 处** |
| `test_new_bugs.py:55`（同文件内） | 字面量 `FROM acl ` | ❌ 不空转 | ✅ 安全 |
| **`test_new_bugs.py:113` `test_audit_logs_table_is_dead`** | **旧 `\s` `\b` 写法** | ✅ **仍然空转** | 🔴 **假阳性，见 3.3** |

### 3.3 🔴 实证：`test_audit_logs_table_is_dead` **确实仍是恒真断言**

QA 做了变异验证——**故意在生产代码里插入一条真实的 `INSERT INTO audit_logs`**：

```python
# 临时探针 server/app/_qa_mutation_probe.py（测完即删）
SQL = "INSERT INTO audit_logs (user_id, action) VALUES (%s, %s)"
```

| 检查 | 结果 |
|---|---|
| 用**旧正则**（`\s` `\b`）grep 探针 | **0 命中**（正则在 BSD grep 上是死的） |
| 用 **POSIX 字符类** grep 探针 | **1 命中**（真实语义） |
| 探针存在时跑 `test_audit_logs_table_is_dead` | **PASSED** ❌← **断言恒真，铁证** |

**结论**：`test_audit_logs_table_is_dead` 是一个**假阳性守卫**——
即使有人真写了 `INSERT INTO audit_logs`，它也不会报警。

**但它当前"断言的结论"仍然是对的**：`audit_logs` 确实没有写入点
（POSIX 正则实测 0 命中；全仓库 `audit_logs` 只出现在 DDL、文档和测试文件里）。
所以这是**测试质量问题（守卫失效），不是产品缺陷（结论正确）**。

> **定性：🟡 P2 · 测试质量债 · 本次不修**（团队lead 指示不修，QA 记录在案）
> **建议修法（1 行）**：把 `test_new_bugs.py:114` 的
> `r"INSERT\s+INTO\s+audit_logs\b|audit_logs\s*\("` 换成
> `r"INSERT[[:space:]]+INTO[[:space:]]+audit_logs|audit_logs[[:space:]]*\("`，
> 并把 grep 根目录从 `server` 改成 `server` + `migrations`（DDL 在 migrations 里）。
> **同时 `server/tests/README.md` 已加警示段**（QA 已补，见第七节）。

### 3.4 影响严重性评估

| 维度 | 评估 |
|---|---|
| 对**产品**的影响 | **无**。acl 表修复后已有真实写入路径，FR-28 可用 |
| 对**测试可信度**的影响 | **中**。Round 1 的 P0 结论（"acl 是死表"）是**靠人工 grep 发现的**，不是靠那个恒真测试 —— 结论正确但守卫无效。这说明：**当时的结论没错，但当时的方法有洞** |
| 复发风险 | **高**。只要有人再写 `grep -E "...\s...\b..."`，就会再造一个恒真断言 |
| 建议 | P2 修 1 行 + README 警示（README 已由 QA 补上） |

---

## 四、工程师 3 个"自曝主张"的复核结论

### 主张 1：GET 列表额外返回 `subject_name`（LEFT JOIN users/departments）→ ✅ **接受**

**实现**：
```sql
SELECT a.subject_type, a.subject_id, a.permission,
       CASE a.subject_type WHEN 'user' THEN u.name ELSE dp.name END AS subject_name
FROM acl a
LEFT JOIN users u        ON a.subject_type = 'user' AND u.id = a.subject_id
LEFT JOIN departments dp ON a.subject_type = 'dept' AND dp.id = a.subject_id
WHERE a.doc_id = %s::uuid
ORDER BY a.subject_type, a.subject_id
```

**语义正确性核对（"条件 ON"写法）**：
LEFT JOIN 的 ON 子句逐行求值，**不满足条件时右表列全为 NULL，但左行保留**。
- `subject_type='user'` 的行 → `ON a.subject_type='user' AND u.id=a.subject_id` 为真 → join users；
  同时 `ON a.subject_type='dept' AND ...` 为假 → `dp.name` 为 NULL → CASE 取 `u.name` ✅
- `subject_type='dept'` 的行 → 反之 ✅
- **不存在**一行同时命中两个 JOIN 的情况（`subject_type` 是单值）✅
- 类型匹配：`users.id` / `departments.id` / `acl.subject_id` **都是 uuid** ✅
- `acl.subject_id` 是 `NOT NULL` → 不存在 NULL 参与比较导致的三值逻辑歧义 ✅

**结论：语义正确，无笛卡尔积放大，无行丢失（LEFT JOIN 保行）。接受。**

**边界（已写测试固化）**：`acl.subject_id` **没有外键**，目标用户被删后 LEFT JOIN 出 NULL →
`subject_name` 为 `null` 而**不是整行消失**。这正是 docs/04 里写的
"目标已被删除时为 null"，契约自洽。owner 能看到"有脏数据"，可自行撤销清理 ✅

### 主张 2：DELETE 幂等 + **不做**目标存在性检查 → ✅ **接受（我原本怀疑，核对后结论：必须这样做）**

**我最初的疑问**：POST 对不存在的目标返回 `404 subject_not_found`，
DELETE 对同一个不存在的目标返回 `200 revoked:true` —— **不对称**。
会不会破坏 FR-28「授权后可检索到，撤销后不可」或 docs/07 的 P6 用例？

**核对结论：不但没问题，而且是必需的**：

1. **HTTP 语义正确**。RFC 9110 明确 DELETE 应当是幂等方法。
   "撤销一条不存在的授权"是清理动作，返回 200 表达"该状态已达成"，
   比 404 更符合调用方预期（重试安全）。

2. **没有外键 → 孤儿记录必然存在 → 必须能清**。
   `migrations/0001_init.sql:48-54` 里 `acl.subject_id uuid NOT NULL`，
   **没有 REFERENCES**。所以"用户被删除后，acl 行还留着"是**正常状态**。
   如果 DELETE 做存在性检查，这些孤儿行就**永远清不掉**——
   GET 列表里会永远挂着一个 `subject_name: null` 的僵尸授权。
   工程师的选择是**唯一正确**的。

3. **不泄露信息**。DELETE 的调用者必须是 owner/admin（权限判定在先，见主张 3），
   他本来就有权知道该文档的完整 ACL 列表。"目标是否存在"对他**没有任何额外价值**。
   反过来，如果 DELETE 做存在性检查，反而会引入"能探测 uuid 是否存在"的侧信道。

4. **不影响 FR-28 / P6**。FR-28 的链路是：
   `POST 授权 → acl 表有行 → ACL 谓词的 EXISTS 分支命中 → 可检索`；
   `DELETE 撤销 → 行被删 → EXISTS 不命中 → 不可检索`。
   DELETE 幂等与否**只影响"撤销一条本就不存在的记录"的返回码**，
   不影响"撤销后是否可检索"这个核心语义。
   （P6 的正向路径依赖 POST，POST 的目标存在性检查**保留**了 —— 那里是必要的，
   因为"给一个不存在的人授权"是业务错误，不是清理动作。）

5. **QA 补写了正向测试**：`test_claim2_revoke_is_idempotent_when_no_record_existed`、
   `test_claim2_revoke_does_not_probe_subject_existence`、
   `test_claim2_revoke_still_denies_unauthorized_user` —— 三条同时锁住
   "幂等 + 不探测 + 仍要权限"三个约束，防止将来有人"顺手补个存在性检查"。

**结论：接受。建议在 docs/04 里补一句不对称的理由**（工程师已在文档里写了
"撤销也是幂等的：本来就没有这条授权时同样返回成功（撤销是清理动作）"，
建议再加半句"因为 acl.subject_id 无外键，孤儿记录需要能被清理"，
把"为什么不对称"讲清楚，避免后来人当成不一致去"修"）。

### 主张 3：权限判定先于目标存在性（防信息泄露）→ ✅ **接受，且实测成立**

**实测证据（QA 独立写的可观测测试）**：

| 场景 | 越权用户看到的响应 |
|---|---|
| 目标**存在** | `403 forbidden` |
| 目标**不存在** | `403 forbidden` |
| 文档**存在**（非自己的） | `403 forbidden` |
| 文档**不存在** | `404 not_found` |

前两行**完全一致** → 越权用户**无法**用响应差异探测"某个 user/dept uuid 是否存在" ✅

**为什么文档存在性仍有 404/403 差异**：这是 REST 惯例且**可接受**——
404 = "资源不存在"，403 = "资源存在但你没权限"。
知道文档存在 ≠ 知道内容；而知道**用户**存在是有意义的 PII 探测，所以后者必须抹平。
工程师的顺序设计正确 ✅

**已写测试固化**：`test_unauthorized_user_cannot_distinguish_existing_vs_missing_subject`
（断言两次响应的 `(status_code, detail)` 元组**完全相等**）、
`test_unauthorized_user_cannot_distinguish_existing_vs_missing_document`
（断言文档存在性差异码 `[404, 403]` 不被"优化"成 404）。

**补充：权限判定的 SQL 形态** —— `_DOC_RIGHT_SQL`：
```sql
SELECT d.owner_id, u.role FROM documents d
JOIN users u ON u.id = %(uid)s::uuid
WHERE d.id = %(doc_id)s::uuid
```
- `JOIN`（非 LEFT JOIN）：若用户行不存在 → 无行 → 404。
  `get_current_user` 已保证用户存在（`SELECT ... FROM users WHERE api_token=%s`），所以不会误判 ✅
- 具名参数 `%(uid)s` / `%(doc_id)s` —— psycopg3 pyformat **支持**（实测见第六节）✅
- 无任何拼接 ✅

---

## 五、越权防提权复查（铁律 1 的写侧）

### 5.1 越权用户零写入 —— 实测

| 断言 | 结果 |
|---|---|
| 非 owner 非 admin POST → 403 | ✅ |
| 403 时执行的**写语句数 == 0**（不只是"没有 INSERT INTO acl"） | ✅ `conn.write_calls() == []` |
| 403 时**不查** users 表 / departments 表（探测面 = 0） | ✅ |
| 非 owner 非 admin DELETE → 403，零写语句 | ✅ |
| 非 owner 非 admin GET → 403 | ✅ |

### 5.2 构造 payload 绕过 —— 全部被挡住

| 攻击面 | 测试用例 | 结果 |
|---|---|---|
| `subject_type` = `admin` / `role` / `super` / `all` / `USER` / `user'`… / `../../etc/passwd` | 14 个参数化用例 | ✅ 全 400 `bad_subject_type`，**零 SQL** |
| `permission` = `write` / `edit` / `delete` / `admin` / `read'; --` / `read; DROP TABLE acl` | 10 个参数化用例 | ✅ 全 400 `bad_permission`，**零 SQL** |
| `subject_id` = `' OR '1'='1` / `'; DROP TABLE acl; --` / `../../etc/passwd` / `""` / `None` / `123` / `[]` / `{}` | 12 个参数化用例 | ✅ 全 400 `bad_uuid`，**零 SQL** |
| `doc_id` 路径参数 = `../../etc/passwd` / `'; DROP TABLE acl; --` / `... OR '1'='1` / `1 OR 1=1` / `not-a-uuid` / `%2e%2e%2f` | 7 个参数化用例 | ✅ 全 404 `not_found`，**零写语句** |

> `doc_id` 的 uuid 校验是**必需的**：否则 `%(doc_id)s::uuid` 会在库里抛
> `invalid input syntax for type uuid` → 整个请求变 500（而不是 404），
> 且 PG 的错误信息可能回显用户输入。工程师的实现把这条路堵住了 ✅

### 5.3 SQL 注入 —— 零风险

| 检查项 | 结果 |
|---|---|
| `_DOC_RIGHT_SQL` | 具名参数 `%(uid)s` / `%(doc_id)s`，无拼接 ✅ |
| `_SUBJECT_EXISTS_SQL` | 2 条**写死**的 SQL，字典白名单下标，无拼接 ✅ |
| INSERT / DELETE / GET 列表 SQL | 全部字面量常量 ✅ |
| AST 级验证（`ast.parse` + 抽取所有 `conn.execute` 首参 + 模块级常量） | 5 条 SQL **全部是 `ast.Constant`**，无一个变量插值 ✅ |
| **注入总闸测试** | 用户输入的任意 4 字节以上子串**都不出现在执行的 SQL 文本里**，只作为参数出现 ✅ |
| psycopg3 混用检查 | 一条语句里不同时出现 `%s` 和 `%(name)s`（psycopg3 会 `ProgrammingError`）✅ |

### 5.4 自我提权的根因与现状固化

`acl.subject_id` **无外键约束**（DDL `:48-54`），所以写入端是唯一把关口。
QA 写了一条测试固化这个现状：`test_acl_ddl_subject_id_has_no_foreign_key` ——
将来若补上外键，这条会翻红，提示"提权风险已从根上消除，可以简化 acl.py 的权限判定"。

---

## 六、铁律合规核对（对照 `AGENTS.md`）

| 铁律 | 检查 | 结果 |
|---|---|---|
| **铁律 1** 权限只写在 SQL 里 | `grep -rn "ACL" server/ --include=*.py`（排除 tests/）→ 定义只出现在 `server/app/search/sql.py:8`；`acl.py` 里的 "ACL" 全在**注释/docstring/错误消息**里，无常量复制 | ✅ |
| **铁律 1**（常量唯一定义） | AST 级断言：`acl.py` 的**代码**（剥掉 docstring 后）不含 `visibility = 'company'` / `owner_id = %(uid)s` / `EXISTS (` | ✅ |
| **铁律 3** 引用必须有定位 | `DO UPDATE` 现在刷新 `locator` + `token_count`（M1/M2 变异证明断言有效） | ✅ |
| **铁律 8** 不加没被要求的抽象 | `acl.py` **0 个 class 定义**、0 个 sqlalchemy/pydantic/middleware 导入（N10/N11 变异证明） | ✅ |
| **sql.py 一字未动** | `git show HEAD:server/app/search/sql.py \| diff - server/app/search/sql.py` → **逐字节一致**；`git diff --stat` 无 sql.py | ✅ |

**新增文件规模**：`server/app/api/acl.py` = 199 行 / 3 个端点 / 2 个 SQL 常量 /
4 个小helper —— 属于"一个函数够用就一个函数"的量级，**未过度设计** ✅

---

## 七、静态 SQL 语法核对（真库不可跑时的替代验证）

> 本机**无 docker**（团队lead 已确认，QA 亦未尝试安装）、
> **无本地 PostgreSQL**（`which postgres/psql/initdb` 全空、brew 未装）、
> **无 pglast/sqlparse**（无法做真 SQL AST 解析）。
> 以下是**静态核对**结论，全部写成了可执行的测试（`test_acl_api_round2.py`）。

### 7.1 `ON CONFLICT` 目标 vs DDL 主键

| 项 | 值 |
|---|---|
| DDL（`migrations/0001_init.sql:48-54`） | `PRIMARY KEY (doc_id, subject_type, subject_id)` |
| API 的 ON CONFLICT | `ON CONFLICT (doc_id, subject_type, subject_id)` |
| **逐列比对** | ✅ **完全一致** |

PG 对 `ON CONFLICT` 目标的要求是"必须匹配某个唯一索引"，PK 满足 ✅
若不一致，PG 会报 `there is no unique or exclusion constraint matching the ON CONFLICT specification`（真库必炸）。
**已写成测试**：`test_acl_insert_on_conflict_target_matches_ddl_primary_key`
（解析 DDL 拿主键、解析源码拿 ON CONFLICT 目标、逐列比对），
N6 变异证明该测试有效 ✅

### 7.2 psycopg3 pyformat 具名参数

用 **psycopg3 自己的解析器**（`psycopg._queries._query2pg`，psycopg 3.3.8）实测：

| SQL | 解析结果 |
|---|---|
| `_DOC_RIGHT_SQL` | ✅ 占位符 2 个，具名参数顺序 `['uid', 'doc_id']` |
| `_SUBJECT_EXISTS_SQL[user]` / `[dept]` | ✅ 各 1 个位置占位符 |
| `INSERT acl` | ✅ 4 个位置占位符 |
| `DELETE acl` | ✅ 3 个位置占位符 |
| `GET list acl` | ✅ 1 个位置占位符 |

**结论：`%(uid)s::uuid` / `%(doc_id)s::uuid` 在 psycopg3 pyformat 下完全支持** ✅
（psycopg3 官方支持 `%(name)s` 具名占位符，`conn.execute(sql, dict)` 即是。）
另实测 psycopg3 **拒绝**混用 `%s` 与 `%(name)s`（`ProgrammingError:
positional and named placeholders cannot be mixed`），本项目一条语句一种风格 ✅

**⚠️ 一个必须写进清单的细节**：psycopg3 把 Python `str` 以 **`text` OID(25)** 发送
（不是 `unknown`），所以 INSERT 的 `doc_id` / `subject_id` 是以 **text** 送进 uuid 列的。
PG 的 `pg_cast` 里 `text → uuid` 是**隐式转换**（castcontext = 'i'），
赋值上下文允许隐式转换 → ✅ 可行。
但 DELETE / 存在性检查都显式写了 `::uuid`，**风格不统一**（INSERT 没写）。
**建议（不改行为，P3）**：INSERT 也用 `%(doc_id)s::uuid` 形式，
消除对隐式转换的依赖，也让"全显式"成为可机械检查的规范。

### 7.3 `LEFT JOIN ... ON a.subject_type = 'user' AND u.id = a.subject_id` 语义

见第四节主张 1 的逐条核对 → ✅ **语义正确**（LEFT JOIN 保行、ON 逐行求值、
类型 uuid 对齐、`subject_id` NOT NULL 无三值逻辑歧义）。

### 7.4 其它静态核对点

| 项 | 结论 |
|---|---|
| DDL 的 `subject_type CHECK (subject_type IN ('user','dept'))` vs API 的 `SUBJECT_TYPES` | ✅ 一致（测试 `test_acl_ddl_has_check_constraint_matching_api_whitelist` 锁定） |
| `users.role` CHECK 是 `('member','editor','admin')` | ✅ `admin` 判定与 DDL 一致；`editor` 角色**没有** ACL 管理特权（只有 owner 能管自己的文档）——与需求"owner 或 admin"一致 |
| `documents.owner_id` 是 `uuid NOT NULL REFERENCES users(id)` | ✅ 可靠 |
| `owner_id` 比较方式 `str(row["owner_id"]) != str(user.id)` | ✅ psycopg3 的 uuid 列返回 `uuid.UUID`，`deps.py` 也用 `str(row["id"])` → 两侧同为小写带横线格式，**无大小写/格式不一致风险** |
| `acl` 表 `doc_id` 有 `ON DELETE CASCADE` | ✅ 删文档自动清授权（不会有悬空 doc_id） |

---

## 八、本轮发现的问题

### 🔴 P0 / 🟠 P1：**无**

工程师的两个 P0 修复**经变异测试验证确实生效**，本轮**未发现新的产品缺陷**。

### 🟡 P2：`test_audit_logs_table_is_dead` 仍是恒真断言（守卫失效）

- 详见第三节 3.3，**铁证**：插入真实 `INSERT INTO audit_logs` 后该测试仍 PASSED。
- **定性**：测试质量债，不是产品缺陷（结论本身仍然正确）。
- **本次按指示不修**，已记录在案 + `server/tests/README.md` 已加警示段。
- **修法**：1 行（换 POSIX 字符类）+ grep 根目录补 `migrations`。

### 🔵 P3（可选改进，不阻塞上线）

| # | 观察 | 建议 |
|---|---|---|
| P3-1 | INSERT 的 uuid 列依赖 PG 的 `text→uuid` **隐式**转换（其余语句都写了显式 `::uuid`） | INSERT 也写成 `%(doc_id)s::uuid` 风格 |
| P3-2 | `_DOC_RIGHT_SQL` 用 `JOIN users u ON u.id = %(uid)s::uuid`（交叉 join + 过滤）表达"取当前用户角色"，略非常规 | 可写成 `CROSS JOIN users u WHERE u.id = ...` 或独立子查询，可读性更好。**行为无差异** |
| P3-3 | POST 对不存在的目标返回 404、DELETE 返回 200，**不对称** | **不改行为**，但在 docs/04 补一句"因为 `acl.subject_id` 无外键，孤儿记录需要能被清理" |
| P3-4 | `acl` 表 `permission` 列**没有 CHECK 约束**（当前 API 只放行 `read`，ACL 谓词也完全不看该列） | 本版无害；若将来放开 write/edit，需同时加 CHECK 并让读路径区分 permission（`test_acl_predicate_does_not_filter_on_permission_column` 已埋好提醒） |

---

## 九、本轮局限（必须如实写明）

1. **真库不可跑 —— 本轮最大的局限**。
   本机无 docker、无本地 PostgreSQL 16 + pgvector、无 pglast。
   所有 SQL 结论均为**静态核对 + psycopg3 解析器实测**，**未在真 PG 上执行过一句**。
   因此以下风险**尚未被证伪**：
   - PG 对 `ON CONFLICT` 目标的具体报错行为；
   - `text→uuid` 隐式赋值转换在**真实 PG 版本**上的表现；
   - `LEFT JOIN` + `CASE` 的实际返回列类型与 NULL 行为；
   - 事务边界（`tx()` 的 commit/rollback）在真实失败路径上的行为。

2. **DB 全 mock**。`test_acl_api.py` / `test_acl_api_round2.py` 全部用 mock 连接，
   断言的是**SQL 形态与调用顺序**，不是数据库的语义结果。
   "ACL 授权后 C 真能搜到"这条**端到端**语义**只做了静态链路核对**
   （`POST → acl 行 → ACL 谓词 EXISTS 命中 → retrieve 传 uid/dept`），**未真跑**。

3. **变异测试是抽样，不是穷举**。15 个变异体覆盖了本轮所有关键断言的**主要失效模式**
   （漏字段 / 换顺序 / 删校验 / 改常量 / 拼字符串 / 加抽象），但不可能覆盖全部。

4. **未评估并发**。ACL 授权 + 并发检索的竞态（授权瞬间的可见性）未测。

### 上线前必做清单（docs/07 现在具备了可执行条件）

> docs/07 的 P1–P7 权限验收用例此前"完全未测"且"没有接口可测"——
> **现在 `POST/DELETE /api/documents/{doc_id}/acl` 已经提供，P6 具备了可执行条件**。

- [ ] **C1** 起 PostgreSQL 16 + pgvector，真跑一遍
      `INSERT INTO acl (...) ON CONFLICT (doc_id, subject_type, subject_id) DO UPDATE SET permission = EXCLUDED.permission`
      —— 确认无 "no unique or exclusion constraint matching" 报错
- [ ] **C2** 真库确认 `text→uuid` 隐式赋值转换可行（INSERT 的 doc_id/subject_id），
      或按 P3-1 改成显式 `::uuid` 后再验
- [ ] **C3** 真库跑 `docs/07` P6：**给 C 的部门插 acl 授权后，C 能搜到**（正向）
- [ ] **C4** 真库跑 FR-28 **撤销后不可**：`DELETE` 授权 → C 再搜 → `hits` 为空（反向）
- [ ] **C5** 真库确认 `GET /api/documents/{doc_id}/acl` 的 `subject_name`：
      正常目标返回名字；**删除该用户后**返回 `null`（孤儿记录可见且可清理）
- [ ] **C6** 真库确认 `DELETE` 撤销一条**不存在**的授权返回 200 `revoked:true`（幂等）
- [ ] **C7** 真库确认越权用户（普通 member、既非 owner 也非 admin）：
      POST / DELETE / GET 三个端点**全部 403**，且 acl 表**无任何行被写入**
- [ ] **C8** 真库确认 `docs/07` P1–P5（P3 用 C 的部门搜 A 的 dept 文档搜不到 → 授 acl 后能搜到）
- [ ] **C9** 补 `audit_logs` 写入（合规追溯缺口，本轮未修，与本修复无冲突）
- [ ] **C10** 修 `test_audit_logs_table_is_dead` 的 POSIX 正则（P2，1 行）

---

## 十、落盘产物

| 产物 | 路径 |
|---|---|
| **Round 2 QA 新增测试（72 用例）** | `server/tests/test_acl_api_round2.py` |
| 测试说明（新增 BSD grep 警示段 + 新文件映射） | `server/tests/README.md`（已更新） |
| **本报告** | `deliverables/software-company/kb-deskpet-test-report-round2-2026-11-06.md` |
| Round 1 报告（已加失效引用批注 + 指向本报告） | `deliverables/software-company/kb-deskpet-test-report-2026-11-06.md` |
| 变异测试脚本（QA 工具，非交付物） | `/tmp/kbqa_backup/mutate.py`、`mutate2.py` |
| 原始文件备份（还原用） | `/tmp/kbqa_backup/{pipeline,acl}.py.orig` + `orig.sha256` |

---

## 十一、路由决策

**Send To → NoOne。**

- 两个 P0 修复**经 15 个变异体验证确实生效**，不是恒真断言；
- 全量 152 passed，**未发现新的 P0/P1 产品缺陷**；
- 3 个自曝主张**全部接受**（主张 2 我原本怀疑，核对 DDL 与 FR-28/P6 后确认**必须如此**）；
- 铁律 1 / 3 / 8 全部合规，`sql.py::ACL` **逐字节未改**；
- 遗留 **1 个 P2 测试质量债**（`test_audit_logs_table_is_dead` 仍空转）+ 4 个 P3 可选改进，
  **均不阻塞上线**，已列入上线前清单 C10。

**下一步不在 QA，而在工程师 + 运维**：按第九节 C1–C8 在真库上跑一遍
`docs/07` 的 P1–P7 权限验收 —— **这批用例现在第一次具备了可执行条件**，
是本次修复真正闭环的最后一步。
