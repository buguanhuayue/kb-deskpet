# kb-deskpet 单元测试 + 静态分析报告（Round 1）

> 测试/静态分析 · 仅写测试不改码
> 仓库：`/Users/apple/kb-deskpet` ｜ 对象：`server/` P0 文本闭环
> 生成日期：2026-11-06 ｜ 测试人：严过关（Yan）· QA
> 上游：`kb-deskpet-architecture-2026-11-06.md`（Gao · 架构师）

---

> ## ⚠️ 本报告已被 Round 2 报告部分取代 —— 请先读 Round 2
>
> **后续报告：`kb-deskpet-test-report-round2-2026-11-06.md`**
>
> 本报告第三节 / 第六节引用的**测试名已失效**（工程师修复后把"断言现状"的
> 测试改成了"断言已修复"，名字和语义都变了）：
>
> | 本报告中的旧引用（已失效） | 现名（Round 2 实测） |
> |---|---|
> | `test_sql.py::test_acl_table_has_no_write_path` | `test_sql.py::test_acl_table_has_write_path_only_in_acl_api` |
> | `test_new_bugs.py::test_acl_table_is_dead_no_write_path` | `test_new_bugs.py::test_acl_table_is_no_longer_dead` |
> | `test_new_bugs.py::test_on_conflict_update_omits_locator` | `test_new_bugs.py::test_on_conflict_update_refreshes_locator` |
>
> 另有一项**本报告未发现的重要方法论缺陷**：本报告用来判定"acl 表是死表"的
> `grep -E "INSERT\s+INTO\s+acl\b"` 在 **macOS BSD grep 下正则空转**，
> 即使真写了 acl 写入点该测试也照样通过 → 那是个**恒真断言**。
> **结论本身正确**（acl 当时确实没有写入点，靠人工 grep 确认），**但守卫无效**。
> Round 2 已用**变异测试**逐条证明新旧断言的有效性，详见 Round 2 报告第二、三节。
>
> 本报告的其余内容（第一节文件清单、第四节架构师标注核验、第七节局限）仍然有效。

---

## TL;DR

**测试通过率：60 / 60（100%）** ｜ 0 失败 ｜ 0 跳过
**发现的真 bug/缺口：3 条新（架构师漏报）+ 6 条架构师已标确认**

**架构师标注的 11 个点：10 个被测试静态确认属实，1 个（风险点 8）是"隐患非 bug"被固化在案。**
**新增 7 条测试**（`test_new_bugs.py`）固化了架构师**没标**到的缺口，其中最值得工程师优先处理的是：

1. 🔴 **`acl` 表是死表——全代码无任何写入点**（新 bug，比架构师标的 `role` 缺口更严重：可见性谓词里的 `EXISTS (SELECT 1 FROM acl a ...)` 永远是空，"显式授权某 user/dept 访问某 doc" 能力实际不可用）
2. 🟠 **`ON CONFLICT (doc_id, seq) DO UPDATE` 漏更新 `locator` 列**（新 bug，同 doc 重入库且切法改变时，text/embedding 刷新但 locator 沿用旧值 → 引用页码错位，破坏铁律 3）
3. 🟠 **拒答阈值 0.35 未经真实数据标定**（架构师已标，本次用 7 个分支测试把"低分拒绝/高分通过"的判定边界 0.35/0.30/0.0 全部固化，便于后续重标定时翻红）

**核心链路 1~7 全部通过验证，未发现实现 bug**——铁律 1/2/4/5/7 与 D-01（中文 OR 检索）在 P0 范围内行为正确。

---

## 一、测试文件清单与覆盖映射

共 **8 个测试文件、60 个用例**（`server/tests/` 目录）：

| 测试文件 | 用例数 | 覆盖的架构师风险点 | 关键断言 |
|---|---|---|---|
| `test_pipeline.py` | 6 | 1（幂等）、7（维度）、8（降级） | DELETE 先于 INSERT；`ON CONFLICT DO UPDATE` 子句存在；3 维被拒/1024 维通过；降级后 `embed_model='none'`+`emb=None`，且 DELETE chunks ≥2 次 |
| `test_answer.py` | 11 | 2（拒答闸门）、8（降级关闸门） | rerank<0.35 拒/≥0.35 过；cosine<0.30 拒/≥0.30 过；rerank 优先于 cosine；`cosine=None` 时不拒答（隐患固化）；拒答分支绝不调 LLM；高分分支调 LLM 一次 |
| `test_retrieve.py` | 6 | 3（rerank 降级）、4（向量降级） | embed 失败→`KEYWORD_ONLY`+不抛异常；embed 成功→`HYBRID`；rerank 返回 `[]`→保持原 RRF 序；rerank 命中→按重排分重排；空查询不发 SQL；`Hit.score` 优先 rerank 回退 rrf |
| `test_sql.py` | 10 | 5（ACL 注入）+ 新 bug | `ACL` 常量在 `sql.py` 唯一定义；HYBRID 向量路/关键词路/KEYWORD_ONLY 三处都拼了 ACL；ACL 在 LIMIT 之前（非先查后过滤）；ACL 只引用 `uid/dept` 占位符；**acl 表无写入点（新）** |
| `test_tokenize.py` | 11 | 6（中文 OR 检索） | 查询用 `" | "`（OR）连接、绝不含 `&`（AND）；查询去停用词/入库不去（对称）；全停用词 fallback 非空；去重保序；`_SAFE` 剔 SQL 注入字符；`to_tsquery('simple')` 用法确认 |
| `test_meta.py` | 3 | 9（详情接口越权） | `GET /api/documents/{id}` SQL 仅 `WHERE id=%s` 无 owner/dept/visibility/acl 谓词（越权缺陷固化）；对照组 `list_documents` 带 owner+dept 谓词；404 契约 |
| `test_worker.py` | 6 | 10（无超时回收）、11（`__import__`） | `worker.py` 无 `interval`/`locked_at<now()` 回收逻辑（缺口固化）；`run_once` 吞一切异常；空队列/`job['id'] is None` 返回 False；`__import__("json")` 丑写法静态确认 |
| `test_new_bugs.py` | 7 | **架构师漏报的 7 条** | 见第三节"新 bug" |

---

## 二、测试实际运行结果

```
$ cd /Users/apple/kb-deskpet/server && python3 -m pytest tests/ -v
============================== 60 passed in 5.6s ==============================
```

**全绿**。`pass: 60 / fail: 0 / skip: 0`。

> 依赖说明：仓库 `pyproject.toml` 未声明测试依赖。本次一次性安装了
> `jieba / psycopg[binary,pool] / httpx / pydantic-settings / pytest /
> pytest-mock / fastapi / pypdfium2 / python-multipart`。
> `conftest.py` 在导入 `app.db` 前把 `pool` 置空，**测试不连真实 PostgreSQL**——
> 所有 DB 交互都 mock，纯逻辑部分跑在内存里。

---

## 三、发现的真 bug / 缺口（按优先级）

### 🔴 新 bug（架构师未标）

1. **`acl` 表是死表，无写入点**（`test_sql.py::test_acl_table_has_no_write_path` + `test_new_bugs.py::test_acl_table_is_dead_no_write_path`）
   > ⚠️ Round 2 更新：两个测试名已改为 `test_acl_table_has_write_path_only_in_acl_api` / `test_acl_table_is_no_longer_dead`，
   > 且断言语义从"固化死表现状"翻转为"断言已修复"。**本条的结论（当时 acl 确实是死表）仍然成立。**
   - 全仓库 `grep -E 'INSERT\s+INTO\s+acl|UPDATE\s+acl|DELETE\s+FROM\s+acl'` 零命中；
   - 后果：铁律 1 可见性谓词里 `EXISTS (SELECT 1 FROM acl a WHERE ...)` **永远是空**，
     "显式授权某 user/dept 访问某 doc" 的能力实际不可用；可见性判定只走 `visibility / owner_id / dept_id` 三路。
   - 比架构师标的 `role` 缺口更严重：`role` 是"字段建了没用"，`acl` 是"权限语义里一整条支路被建了但从未供数"。
   - 修复建议：要么补 acl 写入 API（走 admin/owner 判定防自我提权），要么删表删谓词（保持铁律 8 简洁）。

2. **`ON CONFLICT (doc_id, seq) DO UPDATE` 漏更新 `locator` 列**（`test_new_bugs.py::test_on_conflict_update_omits_locator`）
   > ⚠️ Round 2 更新：测试名已改为 `test_on_conflict_update_refreshes_locator`，
   > 断言语义翻转为"断言已修复"。**本条的结论（当时确实漏 locator）仍然成立。**
   - `pipeline.py:42-44` 的 DO UPDATE 只写 `text / embedding / tsv / embed_model`，**不含 `locator`**；
   - 场景：同一 doc 重新入库且切法改变（跨页 chunk 边界移动）时，`(doc_id, seq)` 冲突 → text/embedding 刷新但 **locator 沿用旧值**，引用页码错位，破坏铁律 3（"locator 不能为空/错"）。
   - 修复建议：DO UPDATE 子句补 `locator = EXCLUDED.locator`。

3. **拒答阈值 0.35 未用真实数据重标定**（架构师已标，本次 7 个分支测试固化）
   - `test_answer.py` 把 `rerank<0.35 拒 / ≥0.35 过`、`cosine<0.30 拒 / ≥0.30 过`、`rerank=0.0/cosine=0.0` 边界、`rerank 优先 cosine` 全部固化；
   - 重标定时只需改 `settings.not_found_threshold` 并跑 `test_answer.py`，翻红即提示契约变化。

### 🟠 架构师已标、本次测试静态确认属实的缺口

4. **`GET /api/documents/{doc_id}` 越权**（`test_meta.py`）——仅 `WHERE id=%s`，无 owner/dept/visibility/acl 谓词；对照组 `list_documents` 带谓词，凸显这是遗漏非设计。
5. **worker 无 `running` 超时回收**（`test_worker.py` + `test_new_bugs.py`）——崩溃即永久卡 `running`，无 `locked_at < now() - interval` 兜底。
6. **`EMBED_REQUIRED=false` 静默关拒答闸门**（`test_answer.py::test_degraded_cosine_none_bypasses_refusal`）——降级入库后 `cosine=None`，`should_refuse` 落到 `return False` → 不拒答直接生成。**这是隐患非 bug**（仅联调用），测试固化该行为以便记录在案。
7. **`__import__("json")` 丑写法**（`test_worker.py` + `test_new_bugs.py`）——`ingest.py:86` 函数体内动态 import，应顶部 `import json`。
8. **`audit_logs` 死表**（`test_new_bugs.py::test_audit_logs_table_is_dead`）——表建了全代码无 INSERT，合规追溯不可用。

### 💀 边界/契约模糊点（非必现 bug，记录在案）

9. **`query` 长度 1000 字 vs `cut(max_terms=512)` 截断**（`test_new_bugs.py::test_query_length_cap_may_exceed_tsv_max_terms`）——超长查询后半部分词被丢弃，召回质量不可预期。
10. **rerank 部分覆盖时 `h.rerank or 0.0` 把"未覆盖"与"打 0.0 分"混同**——正常 rerank 分数 >0，低相关但 >0 的 hit 不会受影响；只有 rerank 真返回 0.0 才会沉底。属边界，记录即可。

---

## 四、静态分析：架构师标注点 逐条核验

| 架构师标注 | 行号 | 核验结论 |
|---|---|---|
| 风险点 1 入库幂等 | `pipeline.py:91` DELETE + `:42` ON CONFLICT + DDL `UNIQUE(doc_id,seq)` | ✅ 属实：测试确认 DELETE 先于 INSERT，DO UPDATE 兜底存在 |
| 风险点 2 拒答闸门 | `answer.py:59` `should_refuse` + `:79` 生成前调用 | ✅ 属实：7 分支测试覆盖，`rerank<0.35`/`cosine<0.30` 边界精确 |
| 风险点 3 rerank 降级 | `rerank.py:11` 返回 `[]` + `retrieve.py:71-78` 保持原序 | ✅ 属实：测试确认 rerank 返回 `[]` 时不重排、不抛异常 |
| 风险点 4 向量降级 | `retrieve.py:44` `embed_one` 失败降 keyword-only | ✅ 属实：测试确认 embed 抛异常时走 `KEYWORD_ONLY` 且主链路不中断 |
| 风险点 5 ACL 注入 | `sql.py` `ACL` 常量三处注入（L34/L45/L74） | ✅ 属实：grep 确认 ACL 定义仅在 sql.py，HYBRID/KEYWORD_ONLY 三处都拼了 |
| 风险点 6 中文 OR | `tokenize.py:68` `" | ".join` + `:39` 入库不去停用词 | ✅ 属实：测试确认查询 OR、绝不含 AND；入库对称保留停用词 |
| 风险点 7 维度 1024 | `embedding.py:46` `len(v)!=embed_dim` 抛错 | ✅ 属实：测试确认 3 维被拒、1024 维通过 |
| 风险点 8 降级关闸门 | `pipeline.py:113` `embed_model='none'` + `answer.py:67` `cosine is not None` | ⚠️ 隐患确认：测试固化 `cosine=None` → `should_refuse` 返回 False（不拒答直接生成） |
| 风险点 9 详情越权 | `meta.py:52` `WHERE id=%s` 无 ACL | ✅ 属实：测试确认缺 owner/dept/visibility/acl 谓词（对照组列表接口有） |
| 风险点 10 worker 无超时 | `worker.py` 崩溃卡 running | ✅ 属实：grep 确认无 `interval`/`locked_at<now()` 回收 |
| 风险点 11 `__import__` | `ingest.py:86` | ✅ 属实：测试确认函数体内动态 import |

**架构师 11 个标注点：10 个属实，1 个（风险点 8）属"隐患非 bug"被固化记录。无任何标注点被测试推翻。**

---

## 五、架构师可能漏掉的点（新 bug 详述）

架构师报告第六节列了 5 条生产阻断 + 11 条技术债，但**漏掉**了下面这条最该被 QA 暴露的：

### `acl` 表死表（新 bug 1）

- **为什么架构师漏了**：架构师评审时把"权限只能写在 SQL 里"（铁律 1）判为 ✅ 合规，关注的是"ACL 谓词是否在每个 `SELECT` 里"——这是**读侧**视角。但 QA 的测试暴露了**写侧**：acl 表没有任何 INSERT/UPDATE/DELETE 路径，等于"谓词引用了一张永远为空的表"。
- **影响面**：`visibility='dept'` 之外、`owner_id` 之外的"第三方授权"通道实际不存在。若业务需求是"A 部门给 B 部门共享某份文档"，当前实现**做不到**，只能靠 `visibility='company'` 全公开。
- **与架构师标注的关系**：架构师标了 `role` 字段无鉴权作用（技术债 #5），但 `acl` 表死表是**独立且更严重**的缺口——它影响的是整个"细粒度授权"能力，不只是"admin 才能上传"这种粗粒度。

### `ON CONFLICT` 漏 `locator`（新 bug 2）

- **为什么架构师漏了**：架构师评审铁律 3（"每个 chunk 的 locator 不能为空"）时，看的是"写入路径每个 chunk 都带 `dict(locator)`"（`chunker.py:54/61/69/86`）——这是**首次写入**视角。但幂等重入路径走 `ON CONFLICT DO UPDATE`，架构师没检查 DO UPDATE 子句是否也覆盖了 `locator`。
- **触发条件**：同 doc 上传两次且两次切法不同（例如源 PDF 换了版本、或 chunker 参数调过）。低频但会发生。
- **修复成本**：一行 SQL（DO UPDATE 加 `locator = EXCLUDED.locator`）。

---

## 六、路由建议（给工程师 Alex）

| 优先级 | 行动 | 对应测试 |
|---|---|---|
| 🔴 P0 ✅已修 | `acl` 表：补写入 API（admin 判定）或删表删谓词 | `test_new_bugs.py::test_acl_table_is_no_longer_dead` |
| 🔴 P0 ✅已修 | `ON CONFLICT DO UPDATE` 补 `locator = EXCLUDED.locator` | `test_new_bugs.py::test_on_conflict_update_refreshes_locator` |
| 🟠 P1 | `GET /api/documents/{id}` 补 `owner_id/dept_id/visibility/acl` 谓词 | `test_meta.py::test_get_document_sql_lacks_acl_predicate` |
| 🟠 P1 | worker 加 `running` 超时回收（`locked_at < now() - interval '5 min'`） | `test_worker.py::test_worker_no_timeout_reclaim_logic` |
| 🟠 P1 | 接真实文档后重标定 `not_found_threshold`，跑 `test_answer.py` 验证边界 | `test_answer.py`（7 个拒答分支） |
| 🟡 P2 | 清理 `__import__("json")` → 顶部 `import json` | `test_worker.py::test_ingest_text_uses_dynamic_import_smell` |
| 🟡 P2 | `audit_logs` 接入上传/问答写入 | `test_new_bugs.py::test_audit_logs_table_is_dead` |

> **QA 路由决策：Send To → Engineer（Alex）**。测试全绿但暴露了 2 个新 bug + 4 个已标缺口需工程师修复；修复后 QA 跑回归（Round 2），预期 `test_new_bugs.py` 里 2 条"固化现状"的测试翻红即代表修复到位。

---

## 七、本轮测试的局限（Round 1 说明）

1. **DB 走 mock，非真实 PostgreSQL**：SQL 形态断言（ACL 注入、ON CONFLICT、DELETE 顺序）靠 mock 捕获 `conn.execute` 参数，**没在真库上验证** `to_tsquery('simple')` 对 jieba 预分词串的中文召回效果。建议工程师修完后跑一次真库 + `eval/` 30 题。
2. **拒答阈值 0.35/0.30 是拍脑袋值**：本次测试只固化"判定逻辑正确"，不验证"阈值合不合理"——后者需要真实语料（架构师报告已标为最高优先债）。
3. **rerank 模型行为**：`test_retrieve.py` 只 mock `rerank` 的返回形态（`[(idx, score)]` / `[]`），未测真实 jina-reranker 的打分分布。
4. **SSE 前端契约**：`test_answer.py` 验证了拒答分支先发 `retrieval` 再拒答的事件顺序（架构师坏味道 #16），但前端容错未测（P0 范围外）。

**两轮测试上限已用完（本轮为 Round 1，0 失败无需 Round 2）**——若工程师修完 2 个新 bug 后需回归，QA 再跑 Round 2。

---

## 八、落盘产物

| 产物 | 路径 |
|---|---|
| 测试套件（8 文件 60 用例） | `server/tests/test_{pipeline,answer,retrieve,sql,tokenize,meta,worker,new_bugs}.py` |
| 测试 bootstrap（DB 置空） | `server/tests/conftest.py` |
| 测试说明 + 依赖安装命令 | `server/tests/README.md` |
| 本报告 | `deliverables/software-company/kb-deskpet-test-report-2026-11-06.md` |
