# AGENTS.md —— 给 AI 编码工具的约束

改这个仓库之前先读完。违反以下条款的补丁一律不接受，哪怕它能跑。

## 一、技术栈（不要换）

| 层 | 选型 | 不许换成 |
|---|---|---|
| API | FastAPI + psycopg3（手写 SQL，无 ORM） | SQLAlchemy ORM / Django |
| 库 | PostgreSQL 16 + pgvector + tsvector | Milvus / Qdrant / ES（P2 之前不谈） |
| 队列 | `jobs` 表 + `FOR UPDATE SKIP LOCKED` | Redis / Celery / RabbitMQ |
| 向量化 | 本地 `embed` 容器：jina-embeddings-v3（1024 维） | 云端 API（曾用硅基流动，余额耗尽即停摆） |
| 重排 | 本地 `embed` 容器：jina-reranker-v2-base-multilingual | 云端 rerank（失败必须可降级，见铁律 5） |
| 生成 | Agnes `agnes-3.0-flash`（OpenAI 兼容） | 自建推理 |
| 前端 | P0 单页验收台；P1 再上 React | 现在就上 Tauri |

## 二、八条铁律

1. **权限只能写在 SQL 里。** 任何 `SELECT ... FROM chunks` 都必须带 `search/sql.py` 的 `ACL` 谓词。禁止先查后过滤。
2. **维度锁死 1024。** 换 embedding 模型必须同时改 DDL、全量重跑，不允许"先兼容两种维度"。
3. **引用必须有定位。** 每个 chunk 的 `locator` 不能为空；PDF 给 `{"page":n}`，视频给 `{"start":s,"end":e}`。没有定位的答案等于没有答案。
4. **检索不到就拒答。** 闸门在 `search/answer.py::should_refuse`，任何"让模型自己判断有没有"的写法都是错。
5. **重排必须可降级。** `services/rerank.py` 返回空列表时链路照常走完。
6. **中间产物即时删。** 视频音轨、分段文件、临时截图在处理完立刻删除，不留盘。
7. **入库幂等。** 重新处理同一 doc 必须 `DELETE FROM chunks WHERE doc_id=...` 后再写，靠 `UNIQUE(doc_id, seq)` 兜底。
8. **不加没被要求的抽象。** 没有第二个实现之前，不要写 `BaseParser` / `AbstractStore`。一个函数够用就一个函数。

## 三、中文检索的唯一正确姿势

PostgreSQL 的 `simple` 分词配置对中文无效。本项目做法：

- 入库：`to_tsvector('simple', jieba切好并用空格连接的文本)`
- 查询：`to_tsquery('simple', jieba切好去停用词、再用 ' | ' 连接的文本)`

**查询必须是 OR 连接，不是 AND。** `plainto_tsquery` 默认"所有词都要命中"，
中文一句切五六个词，缺一个就整条检索归零——这个坑已经踩过（见缺陷 D-01）。
OR 之后由 `ts_rank_cd` 按命中数量排序，多命中的自然排前。

两处必须都走 `app/search/tokenize.py`。只改一边 = 检索直接归零，且不会报错，极难发现。

## 四、常见坑（已经踩过，别再踩）

- `pypdfium2` 不用 `PyMuPDF`：后者 AGPL，商用有传染风险。
- `pgvector` 的 HNSW 索引**建表后再建**，空表上建反而慢；`ef_search` 默认 40，召回不够时在会话级调，不要重建索引。
- 上传要边写边算 sha256，别读两遍文件。
- SSE 必须设 `X-Accel-Buffering: no`，否则 nginx 会把流攒成一坨。
- Dify 那套 15 个容器跟本项目**无关**，不要往 compose 里塞。
