# kb-deskpet 单元测试

> 仅写测试与静态分析，**不改任何业务代码**；bug 只标注不修（修是工程师的事）。
> 对应架构师报告 `deliverables/software-company/kb-deskpet-architecture-2026-11-06.md`。

## 跑测试

```bash
cd /Users/apple/kb-deskpet/server
pip install -e ".[test]"          # 测试依赖在 pyproject 的 optional-dependencies.test 组
python3 -m pytest tests/ -v
```

**依赖说明**：测试依赖已声明在 `server/pyproject.toml` 的 `[project.optional-dependencies].test`
组（`pytest` / `pytest-mock`），走 `pip install -e ".[test]"` 即可；其余核心依赖
（jieba / psycopg / httpx / pydantic-settings / fastapi / pypdfium2 / python-multipart）
在主依赖组里，会一并装上。**生产镜像的 `pip install -e .` 不会带上测试依赖**。
`conftest.py` 在导入 `app.db` 前把 `pool` 置空，因此**测试不连真实 PostgreSQL**
——所有 DB 交互都用 mock。

## 测试文件 → 架构师风险点映射

| 测试文件 | 覆盖用例 | 对应架构师标注 |
|---|---|---|
| `test_pipeline.py` | 入库幂等、维度校验、降级重写 | 风险点 1、7、8 |
| `test_answer.py` | 拒答闸门、降级关闸门、SSE 流、locator | 风险点 2、8 |
| `test_retrieve.py` | 向量降级、rerank 降级、RRF 序、空查询 | 风险点 3、4 |
| `test_sql.py` | ACL 注入、ACL 唯一性、ACL 无写路径 | 风险点 5 + **新 bug** |
| `test_tokenize.py` | 中文 OR 连接、停用词对称、tsquery simple | 风险点 6 |
| `test_meta.py` | 越权详情接口 vs 列表接口对照、404 | 风险点 9 |
| `test_worker.py` | `__import__("json")`、worker 吞异常、无超时回收 | 风险点 10、11 |
| `test_new_bugs.py` | 7 条新发现的 bug/缺口固化 | **架构师漏报** |
| `test_acl_api.py` | ACL 授权管理端点行为（owner/admin 门槛、400/403/404 契约） | Round 1 P0 修复回归 |
| `test_acl_api_round2.py` | **Round 2 QA 独立补写**：越权防绕过、权限判定顺序、静态 SQL 核对 | Round 2 独立回归 |

## 设计原则

1. **纯逻辑走纯函数**：分词、拒答判断、RRF 融合、维度校验、locator 文案，
   不依赖数据库。
2. **SQL/DB 走 mock**：`app.db.pool` 在 `conftest.py` 被置空；单测里用
   `mock.patch.object` 打 patch 各模块的 `get_conn` / `tx` / `embed_texts` /
   `rerank` 等外部依赖，**断言调用顺序与 SQL 形态**（如 `ON CONFLICT` 子句、
   ACL 谓词位置、DELETE 先于 INSERT）。
3. **settings 是 pydantic 实例（`embed_enabled` 是 `@property` 不可 setattr）**：
   patch 各模块的 `settings` 引用指向一个独立 `Settings` 实例，避免直接改全局。
4. **新 bug 用源码静态确认**：grep + `inspect.getsource` 提取 SQL/子句，
   固化"现状行为"，便于工程师修复后翻红提示契约变化。

## ⚠️ grep 在 macOS(BSD) 上会空转（Round 2 实测）

BSD grep 的 `-E` **不认 `\s` 和 `\b`**。写成
`grep -E "INSERT\s+INTO\s+acl\b"` 在 macOS 上永远零命中，
于是"断言没有写入路径"的测试**恒为真**——即使真写了也照样通过。

**写测试时必须用 POSIX 字符类**：

```bash
grep -rn -E "INSERT[[:space:]]+INTO[[:space:]]+acl([^a-zA-Z_]|$)" ...
```

已修正：`test_sql.py::test_acl_table_has_write_path_only_in_acl_api`、
`test_new_bugs.py::test_acl_table_is_no_longer_dead`。
**仍空转（P2，本次未修）**：`test_new_bugs.py::test_audit_logs_table_is_dead`。

## 已知"故意保留"的隐患（不是 bug）

- **`EMBED_REQUIRED=false` 静默关拒答闸门**（`test_answer.py::test_degraded_cosine_none_bypasses_refusal`）：
  降级入库后 `cosine=None`，`should_refuse` 落到最后 `return False` → 不拒答直接生成。
  这是**隐患**不是 bug（仅联调用），测试固化该行为，若产品要求"无向量也强制拒答"
  需改 `should_refuse` 并翻红此断言。
- **rerank 部分覆盖时 `h.rerank or 0.0`**：rerank 模型对某 hit 打 0.0 分
  （真实低相关）时，会被误判为"未覆盖"而沉底。属边界，正常 rerank 分数>0。
