# `paradedb.score` 报错导致关键词检索全失败（2026-11-17）

## 一、现象

WeKnora-app 日志每次问答都刷同一组错误：

```
ERROR: `paradedb.score` must be evaluated by a ParadeDB scan.
       If the query does apply a ParadeDB operator, please report it at
       https://github.com/paradedb/paradedb/issues/new/choose (SQLSTATE 0A000)
[176.163ms] [rows:0]
SELECT paradedb.score(id) as score, ... FROM "embeddings"
WHERE "knowledge_base_id" = $1 AND content ||| $2 AND ((is_enabled IS NULL OR is_enabled = $3))
  AND (NOT (knowledge_base_id IN ($4) AND source_type = 0 AND chunk_id <> ''
       AND source_id <> chunk_id
       AND substr(source_id, 1, length(chunk_id) + 1) = chunk_id || '-'))
ORDER BY "score" DESC LIMIT $5

ERROR [Postgres] Keywords retrieval failed: ...
WARNING knowledgebase_search_fanout.go:173 [retainPartialResults]
        | retrieve returned partial results: ...（kb_count=1 result_sets=1 tenant_id=10013/10009/10016）
```

一次提问触发 3 条（fanout 到 3 个库各报一次），**`rows:0`**。

## 二、影响面

`retainPartialResults` 是**静默降级**：关键词（BM25）这一路整体返回错误，混合检索退回单路向量检索。
表现为：

- 词汇精确命中（型号、编号、文件名、命令行片段）召回能力丢失，只剩语义相近
- 每次提问刷 ERROR，掩盖真实故障
- 引用质量下降，且不报错给用户

触发条件：知识库 `question_generation_config` 为 NULL 或 `enabled=false`
（即没开"自动生成问题"的文档库）。线上除 `技术部门知识库`、`lgf` 两个库显式
`{"enabled": true}` 外，其余库全为 NULL → **绝大多数库的关键词路全废**。

## 三、根因

三层，逐层剥离：

1. **直接原因**：SQL 里 `paradedb.score()` 被要求在**非 ParadeDB 扫描**上求值。
   pg_search 的 score 函数依赖 `ParadeDB Base Scan` 的 exec state，普通 bm25 `Index Scan` 没有这个 state。
2. **为什么退化成普通 Index Scan**：`GeneratedQuestionRowPredicate`
   （`internal/types/generated_question_retrieval.go:39`）里含
   **列对列比较** `source_id <> chunk_id`。pg_search 0.26.4 在构建
   `ParadeDB Base Scan` 时无法把含多个 Var 的表达式翻译成 tantivy query 或
   heap_filter，于是 planner 放弃 custom scan，改用 bm25 索引的普通 Index Scan
   （`Index Cond: id @@@ '...'`）。
3. **为什么会出现这个谓词**：为了不让"历史生成问题"行（source_id = chunk_id + "-" + n）
   占满 TopK。技术部门知识库 1325 行里 914 行（69%）都是这类行，所以这个排除逻辑本身是必要的。

### 定位实验（线上库 `技术部门知识库`，pg_search 0.26.4 / paradedb v0.26.4-pg17）

| 变体（其余条件固定为 kb + `content ||| ...`） | 执行计划 | 结论 |
|---|---|---|---|
| 基线，无排除条件 | `Parallel Custom Scan (ParadeDB Base Scan)` | 正常 |
| `+ NOT (knowledge_base_id IN (...))` | `ParadeDB Base Scan` | 正常（单 Var 被翻成 `heap_filter`） |
| `+ NOT (source_type=0 AND chunk_id <> '')` | `ParadeDB Base Scan` | 正常 |
| `+ NOT (source_id <> chunk_id)` | **`Index Scan using embeddings_search_idx`** | **退化** |
| `+ source_id = 'x'`（非索引字段 vs 常量） | `ParadeDB Base Scan` | 正常 → 与"字段是否建索引"无关 |
| `+ knowledge_id <> chunk_id`（两个索引字段列对列） | **`Index Scan`** | **退化** → 确认是 Var-vs-Var |

补充排除项：

- 不是参数化/prepared plan 的问题：`PREPARE` + `force_custom_plan` / `force_generic_plan`
  均正常；`LIMIT $n` 参数化也正常
- 不是 `substr()` / `||` 拼接本身的问题：`substr(source_id,1,3) = 'abc'`、`source_id LIKE 'abc%'` 均正常
- `paradedb.planner_warnings` 不产生任何提示（Planner 直接没考虑 custom scan，不是拒绝使用）

### 上游归属

`internal/types/generated_question_retrieval.go` 是 v0.9.0 新增的"生成问题"检索隔离逻辑，
谓词写法在 SQLite 和 PostgreSQL 两条实现里共用，但只有 pg_search 的 custom scan 会因此退化。

## 四、修复

### 已采用：谓词外裹 `IS TRUE`（1 行改动，已上线）

`internal/application/repository/retriever/postgres/repository.go` 两处
（向量路 ~412 行、关键词路 ~805 行）：

```diff
-  "NOT (knowledge_base_id IN (%s) AND %s)"
+  "((NOT (knowledge_base_id IN (%s) AND %s)) IS TRUE)"
```

`BooleanTest` 让 pg_search 放弃翻译该表达式、直接塞进 `heap_filter`，custom scan 得以保留。
实测（参数化路径）：

```
Parallel Custom Scan (ParadeDB Base Scan) on embeddings
  Exec Method: TopKScanExecState
  Scores: true
     TopK Order By: pdb.score() desc
  Tantivy Query: ... always_filters: [heap_filter: "... IS TRUE"]
```

结果与"完全不加排除条件"逐行一致（top 8 相同，score 相同）。

**语义等价性**：外层多了一对括号，等价于 `(NOT X) IS TRUE`。`X` 为 NULL 时
`NOT X` = NULL → `IS TRUE` = false → 仍被过滤，与原 `NOT X` 在 WHERE 里的行为一致。
（若写成 `NOT (X) IS TRUE`，`IS` 优先级更低会变成 `NOT (X IS TRUE)`，NULL 时反而保留行，所以必须带内层括号。）

### 备选方案（未采用，记录备查）

| 方案 | 做法 | 评价 |
|---|---|---|
| 子查询隔离 | `SELECT * FROM (SELECT ... LIMIT n) t WHERE <谓词>` | 实测同样恢复 `ParadeDB Base Scan`（带 LIMIT 的子查询不会被 PG 展平）；需改造 GORM 查询结构，改动大于 1 行 |
| 应用层过滤 | SQL 不排除，召回后在 Go 里按 `IsGeneratedQuestionSource` 过滤 | 语义最干净，但 TopK 会被生成问题行占掉，需要额外放大 limit |
| 加标记列 | `embeddings` 增加 `is_generated_question boolean`，写入时打标，检索用 `= false` | 最根治（谓词变成"单 Var vs 常量"），但需迁移 + 回填 + 改所有写入路径 |
| 依赖 `paradedb.enable_filter_pushdown` | 已是 `on`，无效 | — |

## 五、部署

镜像 `weknora-app:v0.9.0-rerankfix3`（= 官方 v0.9.0 + rerank 补丁 + 本补丁），
`docker-compose.override.yml` 的 `image:` 指向该 tag。

```bash
# 编译（builder 容器，缓存命中约 25s）
docker exec -e PATH=/usr/local/go/bin:/usr/bin:/bin \
  -e GOPROXY=https://goproxy.cn,direct -e GOSUMDB=off -e GOTOOLCHAIN=local \
  weknora-builder bash -c 'cd /src && CGO_ENABLED=1 go build -tags anydoc \
  -ldflags="-w -s -X github.com/Tencent/WeKnora/internal/handler.Version=v0.9.0-pdbfix \
  -X github.com/Tencent/WeKnora/internal/handler.Edition=standard" \
  -o /src/WeKnora-pdbfix ./cmd/server'

# 打包（Dockerfile 只换二进制）
printf 'FROM wechatopenai/weknora-app:v0.9.0\nCOPY WeKnora-final /app/WeKnora\n' > /tmp/pdbfix/Dockerfile
docker build -t weknora-app:v0.9.0-rerankfix3 /tmp/pdbfix

# 切换（override 已在服务器，备份 docker-compose.override.yml.bak-rerankfix2）
cd ~/weknora && docker compose up -d app
```

补丁文件：`deploy/patches/weknora-v0.9.0-paradedb-score.patch`

**回滚**：

```bash
cd ~/weknora && cp ~/docker-compose.override.yml.bak-rerankfix2 docker-compose.override.yml
docker compose up -d app
```

## 六、验证（2026-11-17 11:24–11:26）

```
INFO [Postgres] Keywords retrieval: query=机房建设方案, topK=50
INFO [Postgres] Keywords retrieval found 5 results      # 李高峰库（config NULL，修复前必失败）
INFO [Postgres] Keywords retrieval found 50 results     # 王晨库（config NULL，修复前必失败）
```

- `docker logs | grep -c paradedb.score` = **0**
- 无 `Keywords retrieval failed`、无 `retainPartialResults` 警告
- `POST /api/v1/knowledge-bases/{id}/hybrid-search` HTTP 200

## 七、遗留观察点

- 该修法依赖 pg_search 对 `BooleanTest` 的处理方式。升级 paradedb 后需回归：
  跑一次提问确认日志无 `paradedb.score`，或直接 `EXPLAIN` 确认 plan 里是 `ParadeDB Base Scan`。
- `retainPartialResults` 的降级只打 WARNING，建议后续在监控里对
  `Keywords retrieval failed` 单独告警——这次故障被静默吞掉很久。
