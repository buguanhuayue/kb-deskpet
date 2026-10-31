# kb-deskpet

公司内部知识库（桌宠入口）—— **P0 文本闭环**：上传 PDF/TXT → 混合检索 → 带页码引用的回答，查不到就拒答。

## 交付文档（先读这个）

| 文档 | 内容 | 谁该读 |
|---|---|---|
| [00-交付总览](docs/00-交付总览.md) | **入口**：系统是什么、当前状态、边界、索引 | 所有人 |
| [01-业务场景与能力边界](docs/01-业务场景与能力边界.md) | 解决谁的什么问题、指标怎么定 | 业务方 |
| [02-部署手册](docs/02-部署手册.md) | 裸机 → 可提问，逐步可执行 | 运维 / 实施 |
| [03-配置参考](docs/03-配置参考.md) | 每个环境变量、改错的后果 | 运维 / 开发 |
| [04-API接口文档](docs/04-API接口文档.md) | 端点、错误码、SSE 协议 | 前端 / 集成方 |
| [05-数据模型与权限](docs/05-数据模型与权限.md) | 表结构、权限 SQL、状态机 | 开发 / DBA |
| [06-运维手册](docs/06-运维手册.md) | 巡检、备份恢复、故障 runbook | 运维 |
| [07-验收标准](docs/07-验收标准.md) | 怎么算交付完成，含实测记录 | 甲方 / 负责人 |
| [08-已知限制与风险](docs/08-已知限制与风险.md) | 做不到什么、有哪些风险 | 所有人 |
| [09-使用手册](docs/09-使用手册.md) | 员工怎么传文件、怎么提问 | 最终用户 |

历史过程文档（非交付件）：[进度与技术说明](docs/进度与技术说明.md)、
[迁移到虚拟机方案](docs/迁移到虚拟机方案.md)。

## 三步跑起来

```bash
cp .env.example .env && chmod 600 .env
# 只需填一个 key：LLM_API_KEY（生成模型）。
# 向量化与重排走 compose 里的本地 embed 容器，无需任何外部 key。

make up        # postgres + embed + api + worker（首次会下载 3.2GB 模型权重）
make check     # 闸门：四项不全绿就别往下走
make seed      # 打印 token，贴到验收台
open http://localhost:9527
```

> 低配机器（内存 < 8GB）可改用云端向量服务，见 [03-配置参考](docs/03-配置参考.md#四向量化)。

## 现在支持什么

| 能力 | 状态 |
|---|---|
| PDF / TXT / MD / CSV 入库 | ✅ 已实测 |
| 中文分词 + 向量 + RRF 混合检索 | ✅ 已实测 |
| 重排（失败自动降级） | ✅ 已实测 |
| 带页码引用、检索不到就拒答 | ✅ 已实测 |
| 部门粒度权限（SQL 内过滤） | ⚠️ 已实现，**未做多部门实测** |
| 本地向量化 / 重排（免云端） | ✅ 已实测 |
| 扫描件 OCR、Word / Excel / 图片 / 视频 | ⏳ 未实现 |
| SSO 登录、审计日志、文档删除 | ⏳ 未实现 |
| 桌宠壳（Tauri） | ⏳ 未开始 |

完整边界见 [08-已知限制与风险](docs/08-已知限制与风险.md)。

## 目录

```
server/app/
  api/        路由（ingest / query / meta）
  ingest/     解析 → 切片 → 向量化（worker 侧）
  search/     检索 SQL / 融合 / 重排 / 拒答闸门
  services/   embedding / rerank / llm / storage（外部依赖都在这里，换供应商只改这一层）
server/embed_service/   本地向量化 + 重排服务（OpenAI 兼容，独立容器）
migrations/  纯 SQL 迁移，按文件名顺序执行
deploy/      pack.sh（打包迁移）/ bootstrap.sh（目标机一键部署）
eval/        评测集（当前 8 题，验收要求 30 题）
docs/        交付文档包
```

## 关键参数在哪改

- 切片粒度：`server/app/ingest/chunker.py` 顶部三个常量（`MIN_CHARS` / `MAX_CHARS` / `OVERLAP`，改完必须跑 eval）
- 融合常数：`RRF_K`（.env）
- 拒答阈值：`NOT_FOUND_THRESHOLD`（.env），**接入真实文档后必须重标定**
- 中文分词：`server/app/search/tokenize.py`（入库和查询共用，改一处等于全改）
- 权限谓词：`server/app/search/sql.py` 的 `ACL` 常量（**全系统唯一一处，改错=越权**）

## 开发约束

见 [AGENTS.md](AGENTS.md) —— 八条铁律，改代码前先读。
