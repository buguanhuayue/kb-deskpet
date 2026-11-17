# WeKnora 虚拟机端架构与技术实现详细分析报告

> 分析对象：192.168.1.234 上的 WeKnora v0.9.0 全栈（服务端 + 前端）
> 分析方式：源码级审计（`~/weknora` 为完整源码仓库）+ 运行时实测（容器/数据库/Redis）
> 生成日期：2026-11-06 ｜ 审计人：Gao

---

## 一、执行摘要

**一句话定位**：WeKnora 是腾讯开源的企业级知识库与检索增强平台，本部署（v0.9.0，2026-10-29 发布）以 **Docker Compose 五容器**形态运行在一台 8 vCPU / 15.6 GiB 的 Ubuntu 24.04 虚拟机上，服务端为 **Go 1.26 单体应用（31.2 万行，410 条路由）**，前端为 **Vue 3.5 + Vite 7 + TDesign 的 SPA**，由容器内 **nginx 做统一网关**；向量检索走 **ParadeDB PostgreSQL 17（pgvector + BM25 双引擎）**，异步任务走 **Redis + asynq**，LLM 生成走线上 API（agnes-3.0-flash），嵌入与重排模型走本机独立容器（jina-v3 / jina-reranker-v2）。

**核心数字速览**：

| 维度 | 数值 |
|---|---|
| 代码规模（Go） | ≈ 31.2 万行 |
| 代码规模（前端） | Vue 3.5 + TS 6，417 行路由表 |
| REST 路由 | 410 条（按 auth_tenant / knowledge / chat / agent / graph / automation / mcp_endpoint / memory / infra 分组） |
| 数据库 | ParadeDB PG 17.11，**123 张表**，134 个版本化迁移 |
| 向量库驱动支持 | 11 种（postgres / ES v7 / ES v8 / milvus / qdrant / neo4j / opensearch / weaviate / 腾讯云 VectorDB / doris / sqlite），本部署用 postgres |
| Agent 工具 | 92 个工具文件（ReAct 引擎，无状态逐轮重建） |
| 聊天管道 | 14 种事件的插件责任链 |
| 容器内存实测 | app 418 MiB / postgres 175 MiB / docreader 62 MiB / frontend 11 MiB / redis 8 MiB / kb-embed 6.2 GiB（上限 8 GiB） |

**成熟度判断**：这是一个**功能面极宽、工程化程度高**的开源产品级系统——多向量库抽象、多租户 RBAC、插件化聊天管道、Agent 工具生态、IM 渠道接入（飞书/钉钉/企微/IMA）、数据源连接器（Notion/Confluence/GitLab/语雀/Seafile/RSS）一应俱全；代价是**资源占用与运维复杂度显著高于轻量方案**，且在本机 15.6 GiB 内存约束下，嵌入/重排服务的历史峰值曾拖垮整机（详见第七节风险）。

---

## 二、部署形态与系统拓扑

### 2.1 宿主机与版本

- **主机**：192.168.1.234，Ubuntu 24.04.5 LTS，8 vCPU / 15.62 GiB RAM
- **软件版本**：WeKnora **v0.9.0**（镜像 `wechatopenai/weknora-app:v0.9.0` 等，全部锁定版本号，不用 latest）
- **源码**：`~/weknora` 为完整 Git 仓库（非仅部署产物），具备源码级分析条件

### 2.2 容器拓扑（实测 6 个常驻容器）

```
                          ┌────────────────────────────────────────────────┐
                          │            VM 192.168.1.234 (8C/15.6G)          │
                          │                                                │
   用户浏览器 ──:9527──►  │  ┌──────────────────┐                          │
                          │  │ WeKnora-frontend │ nginx 网关                │
                          │  │  (11 MiB)        │ 静态资源 + 反代 + SSE     │
                          │  └────────┬─────────┘                          │
                          │           │ WeKnora-network (bridge)           │
                          │           ▼ :8080                              │
                          │  ┌──────────────────┐   ┌───────────────────┐  │
                          │  │   WeKnora-app    │──►│  WeKnora-postgres │  │
                          │  │ Go 单体 (418MiB) │   │ ParadeDB PG 17.11 │  │
                          │  │ 410 路由/API/Agent│   │  123 表 (175MiB)  │  │
                          │  └─┬───────┬────────┘   └───────────────────┘  │
                          │    │       │ gRPC :50051                        │
                          │    │       ▼                                    │
                          │    │  ┌──────────────────┐   ┌───────────────┐ │
                          │    │  │ WeKnora-docreader│   │ WeKnora-redis │ │
                          │    │  │ Python 解析(62MiB)│   │ asynq+SSE(8MiB)│ │
                          │    │  └──────────────────┘   └───────────────┘ │
                          │    │                                             │
                          │    │ kbnet (external network, 别名 embed)        │
                          │    ▼                                             │
                          │  ┌──────────────────┐                          │
                          │  │ kb-deskpet-embed │ jina-v3 (1024维)          │
                          │  │  (6.2GiB/8GiB上限)│ jina-reranker-v2         │
                          │  └──────────────────┘ :8088 仅回环+kbnet        │
                          └────────────────────────────────────────────────┘
                          │
   外部调用 ──:18080──► app 直连 API（绕过前端网关）
                          │
   出网 HTTPS ──────────► apihub.agnes-ai.com (agnes-3.0-flash LLM/VLM)
```

**要点**：

1. **前端即网关**：所有浏览器流量先进 `WeKnora-frontend` 容器的 nginx（宿主 9527 → 容器 80），再由 nginx 反代到 app:8080。app 的 18080 端口另做直连暴露，供 API 调用方绕过前端网关。
2. **app 是双网络容器**：`docker-compose.override.yml` 把 app 同时接入 `WeKnora-network`（官方编排）和 `kbnet`（外部网络）。`kbnet` 上挂着 `kb-deskpet-embed-1` 容器，网络别名 `embed`——这是 WeKnora 用主机名 `embed` 访问本地嵌入/重排服务的全部秘密，**不改动上游任何文件**。
3. **kb-embed 是独立部署的共享模型服务**：属于 kb-deskpet 项目的 `kb-embed` 编排，同时服务 WeKnora 与 kb-deskpet 两个系统；仅绑定 127.0.0.1:8088 + kbnet 内网，不对外。
4. **docreader 不暴露端口**：gRPC 50051 仅在 compose 网络内可达（`expose` 而非 `ports`），无 TLS/认证（注释明确说明依赖网络隔离）。
5. **可选组件全部未启用**：compose 中的 sandbox / searxng / minio / neo4j / qdrant / milvus / weaviate / doris / dex / langfuse / mcp 均为 profile 隔离的 opt-in 服务，本部署一个都没开——检索引擎用 postgres、文件存储用 local、Web 搜索未启用。

### 2.3 端口与网络一览

| 端口（宿主） | 容器 | 用途 |
|---|---|---|
| 9527 | WeKnora-frontend:80 | 浏览器入口（nginx） |
| 18080 | WeKnora-app:8080 | 后端 API 直连 |
| （不暴露） | docreader:50051 | gRPC 文档解析（仅内网） |
| （不暴露） | postgres:5432 | 数据库（仅内网） |
| （不暴露） | redis:6379 | 队列/流（仅内网，有密码） |
| 127.0.0.1:8088 | kb-embed | 嵌入/重排 OpenAI 兼容 API（回环 + kbnet） |

### 2.4 部署定制（override 层）

`docker-compose.override.yml` 只做三件事，干净地叠加在官方编排之上：

```yaml
services:
  app:
    networks: [WeKnora-network, kbnet]        # ① 接入 kbnet 以主机名 embed 访问本地模型
    volumes:
      - ./config/builtin_models.yaml:ro        # ② 声明式内置模型（官方默认注释掉）
      - ./config/builtin_agents.yaml:ro        #    内置 Agent 模板
      - ./config/prompt_templates:ro           # ③ 统一「华夏国数知识小助」提示词设定
networks:
  kbnet: { external: true, name: kbnet }
```

### 2.5 关键运行配置（.env，密钥已脱敏）

| 配置组 | 取值 | 说明 |
|---|---|---|
| `WEKNORA_VERSION` | v0.9.0 | 全家桶镜像版本锁定 |
| `RETRIEVE_DRIVER` | postgres | 向量检索走 PG（未用 ES/Milvus 等） |
| `STREAM_MANAGER_TYPE` | redis | SSE 流状态存 Redis，**进程重启后流可重放/续传** |
| `DISABLE_REGISTRATION` | true | 禁公开注册 |
| `WEKNORA_BOOTSTRAP_SYSTEM_ADMIN_EMAIL` | admin@company.local | 首个系统管理员 |
| `STORAGE_TYPE` / `LOCAL_STORAGE_BASE_DIR` | local / /data/files | 文件存本地卷，未接对象存储 |
| `CONCURRENCY_POOL_SIZE` | 3（默认 5） | 按 8C/15G 收紧 |
| asynq 各池并发 | core=2 / postprocess=1 / enrichment=2 / maintenance=1 / shared=2 | 同上，防止内存超限 |
| `BATCH_EMBED_SIZE` | 8 | 每批嵌入条数 |
| `WEKNORA_MODEL_MAX_CONCURRENCY` | 8（默认 32） | 模型调用并发上限 |
| `MAX_FILE_SIZE_MB` | 50 | 上传单文件上限 |
| `SSRF_WHITELIST` | embed | 允许 app 出站访问 `embed` 主机名（本地模型服务） |
| `GIN_MODE` / `LOG_LEVEL` | release / info | 生产模式 |
| `TZ` / `DEFAULT_LOCALE` | Asia/Shanghai / zh-CN | 中文环境 |

**模型三段路由**（本部署最核心的定制）：

| 模型角色 | 端点 | 模型 |
|---|---|---|
| LLM / VLM（生成） | `https://apihub.agnes-ai.com/v1`（出网） | agnes-3.0-flash |
| Embedding（向量化） | `http://embed:8088/v1`（本地 kbnet） | jinaai/jina-embeddings-v3（1024 维） |
| Rerank（重排） | `http://embed:8088/v1`（本地 kbnet） | jinaai/jina-reranker-v2-base-multilingual |

---

## 三、后端架构与技术实现

### 3.1 技术栈与代码结构

**技术栈**：Go 1.26 + Gin（HTTP 框架）+ GORM（ORM）+ uber/dig（依赖注入容器）+ asynq（Redis 任务队列）+ golang-migrate（数据库迁移）+ ants（协程池）。

**入口流程**（`cmd/server/main.go`）：

```
main()
 ├─ envfile.Load(edition==lite)     # .env 加载（Lite 版自动发现 .env.lite）
 ├─ container.BuildContainer(dig)   # DI 容器装配全部依赖
 ├─ modelCatalogSvc.Start(ctx)      # 模型目录后台刷新
 ├─ systemSettingSvc.SubscribeRedis # 系统设置 Redis 订阅（多实例配置同步）
 └─ signal.Notify → 优雅关停         # 排空预算 + 清理预算；二次信号强断全部连接
```

**代码分层**（internal/ 目录）：

| 层 | 职责 |
|---|---|
| `handler` | HTTP 处理器 + 路由注册（按域拆分的 routes_*.go）+ Edition（标准/Lite 版编译期注入） |
| `middleware` | 认证（JWT/API Key）、租户访问（access.go）、角色守卫（rbac.go）、SSRF 校验等 |
| `application/service` | 业务服务：聊天管道（chat_pipeline）、混合检索、Agent、自动化、审批、沙箱分配等 |
| `application/repository` | 数据访问 + **retriever/**（11 种向量库驱动实现） |
| `agent` | ReAct 引擎、92 个工具、审批（approval/hitl）、运维操作 |
| `datasource/connector` | 外部数据源连接器：飞书(docx/drive/wiki)、钉钉、Notion、Confluence、GitLab、语雀、Seafile、RSS、IMA |
| `container` | dig DI 装配中心（单文件串联全系统） |
| `browserskill` | Rust 编写的浏览器扩展 + 守护进程（local_browser 工具的底层） |

### 3.2 依赖注入：dig 容器

`internal/container/container.go` 是全系统的装配点，从 import 列表即可看出系统全貌：11 个向量库 SDK（elasticsearch v7/v8、milvus、qdrant、neo4j、opensearch、weaviate、tencentvectordb、doris/MySQL 协议、sqlite-vec、postgres/pgvector）、duckdb（数据分析工具用）、grpc（docreader 客户端）、ants 协程池、9 种数据源连接器全部在此注册。**单体 + DI 容器**的形态使部署极简（一个二进制），但启动即加载全部依赖配置。

### 3.3 路由体系（410 条）

路由按域拆分为独立文件（`internal/router/`）：

```
routes_auth_tenant.go   认证 / 多租户 / 邀请 / RBAC
routes_knowledge.go     知识库 / 文档 / 分块 / 上传（含 KB 级 API Key 能力校验）
routes_chat.go          会话 / SSE 流式问答 / continue-stream
routes_agent.go         Agent 会话 / 工具执行 / 审批
routes_automation.go    自动化任务（v0.9.0 新增）
routes_graph.go         知识图谱查询（独立 JSON API）
routes_mcp_endpoint.go  MCP 服务端点管理
routes_memory.go        Agent 长期记忆
routes_infra.go         健康检查 / 系统信息 / 模型目录
routes_background*.go   后台 shell 任务（异步执行/等待/取消）
```

认证模型（来自 Swagger 注释）：**双通道**——`Authorization: Bearer {JWT}`（用户）与 `X-API-Key`（程序化调用；空间 Key 固定访问所属空间，平台 Key 需附带 `X-Tenant-ID`）。

### 3.4 认证与 RBAC：双体系并行

**用户侧（JWT + 租户角色）**：

- `TenantRole` 四级：Owner(40) / Admin(30) / Contributor(20) / Viewer(10)，数值直接比较层级
- SystemAdmin 是**独立通道**（bootstrap 邮件创建，绕过租户体系，走单独中间件判定）
- 跨租户访问由 `WEKNORA_TENANT_ENABLE_CROSS_TENANT_ACCESS` 开关 + 用户 `CanAccessAllTenants` 权限双重控制（本部署默认关闭）
- 中间件集中化：`middleware/access.go` 做租户归属解析，`middleware/rbac.go` 做角色门槛，路由只声明所需等级

**程序侧（API Key 能力分级）**：

- 能力三档：`ingest`（只写）/ `retrieve`（只读）/ `full_access`（读写）
- 空间级 Key 自动绑定所属空间；平台级 Key 需显式传 `X-Tenant-ID`
- **KB 白名单**：Scoped Key 可限定可访问的知识库集合
- 写内容路由（如分块）要求 ingest 能力，读路由要求 retrieve 能力；源码注释特别强调「能编辑所有 chunk 的规则在这条路由上反而更宽松」之类的一致性审查

**加密**：`SYSTEM_AES_KEY`（AES-256，32 字节）统一加密落库的敏感字段——租户 API Key、模型密钥、向量库凭证、搜索供应商 Key 等（v0.4.0 起取代三个旧变量）。**丢失该密钥 = 所有加密数据不可恢复**。

### 3.5 聊天管道：插件责任链（系统最精巧的部分）

`internal/application/service/chat_pipeline/` 实现了**事件驱动的插件管道**：

```
Plugin 接口 = { OnEvent(event, chatManage) error; ActivationEvents() []EventType }
EventManager: 按事件聚合插件 → 构建责任链 → 逐个触发
ChatManage   = PipelineRequest（用户输入） + PipelineState（中间态） + PipelineContext（上下文）
```

**14 种管道事件**（`types/chat_manage.go:374-387`）覆盖问答全生命周期：

```
QUERY_UNDERSTAND → CHUNK_SEARCH → RERANK → MERGE → INTO_CHAT_MESSAGE
→ CHAT_COMPLETION_STREAM → ... （共 14 种，含附件 OCR、引用收集等事件）
```

这套设计的价值：**问答流程的每一步都是可插拔的**——换检索策略、加重排器、改消息组装，都不动主干代码，只增删插件对事件的订阅。v0.9.0 的「WeKnora 助手」「多智能体协作」都是在管道之上叠的新能力。

**SSE 可靠性设计**：`STREAM_MANAGER_TYPE=redis` 后，流式响应的中间状态写入 Redis 而非进程内存——**app 进程重启后，正在进行的对话流可以从断点重放**（continue-stream 路由），前端配合 `useStream` 的认证重试实现无感续传。这是生产级细节。

### 3.6 混合检索链路（RAG 核心）

`knowledgebase_search.go:130-215` 的 HybridSearch 主流程：

```
HybridSearch(查询, KB 列表, 模式)
 ├─ authorizeKBAccess()            # ① 权限闸门：逐 KB 校验调用者访问权
 ├─ validateSameEmbeddingModel()   # ② 一致性闸门：所有 KB 必须同一嵌入模型
 │                                   （防止 1024 维与 768 维向量混算）
 ├─ 主 KB 解析 → 检索参数归一
 ├─ 候选生成（按模式分派）
 │   ├─ 混合模式：向量召回（cosine）+ 关键词召回（BM25）并行
 │   ├─ 纯向量：仅 cosine
 │   └─ 纯关键词：仅 BM25
 └─ 融合（knowledgebase_search_fusion.go）
     ├─ 混合：加权 RRF（Reciprocal Rank Fusion，权重可配，v0.9.0 暴露为设置项）
     ├─ 纯向量：保留原始 cosine 相似度
     └─ 纯关键词：BM25 分数归一化
 → 输出统一为 [0,1] 分数 → 去重 → 截断
```

**设计评价**：三分支各自保证分数可比性再融合，避免了「不同源分数直接相加」的经典错误；RRF 只用排名不用原始分值，对异常分数天然鲁棒。

### 3.7 分块策略：五级 Tier + 自动降级

`ingest` 侧 `strategy.go` 实现五级分块策略：`auto`（默认，按文档类型自动选）→ `heading`（标题层级）→ `heuristic`（启发式）→ `recursive`（递归）→ `legacy`（兼容旧行为）。**验证失败自动降级回退**到下一档，保证任何文档都能完成分块不阻塞流水线。

chunks 表支持**父子分块**（`parent_chunk_id`）与**前后链**（prev/next），为「小块检索、大块喂给 LLM」的上下文扩展策略提供数据基础。

### 3.8 Agent 引擎：ReAct 无状态 + 92 工具

`internal/agent/engine.go` 的 AgentEngine：

- **ReAct 模式**（Reason → Act → Observe 循环），**无状态设计**——每轮从数据库重建完整历史，好处是任意实例可接管任意会话（配合 Redis 流管理实现水平扩展），代价是长会话的 DB 读放大（用 token 估算器 + 压缩器缓解，含溢出恢复逻辑）
- 协作绑定：v0.9.0 的多智能体协作用于任务（durable 子任务、独立会话、实时进度）
- **工具全景**（92 个工具文件，`agent/tools/definitions.go`）：

| 类别 | 工具 |
|---|---|
| 知识检索 | search_knowledge、read_document、query_knowledge_graph（独立 JSON API）、MCP 搜索（文档域） |
| 数据分析 | database_query、data_analysis |
| Web | web_search、web_fetch、local_browser（Rust browserskill 扩展驱动） |
| 执行 | shell_exec、shell_exec_async（后台任务 + 增量输出 + wait/cancel，v0.9.0 新增） |
| 知识库运维 | wiki_ 系列 9 个（创建/编辑/发布 Wiki） |
| 记忆与协作 | memory（长期记忆）、ask_user（人机交互）、todo_write（任务清单）、thinking（推理） |
| 外部 | MCP 协议工具（动态注册） |

- **权限与审批**（v0.9.0 重点）：工具分只读 / 改动前确认 / 自动写三档；持久化人机审批提示（HITL）、挂起的运行、受限授权；审批超时默认 fail-close（`WEKNORA_AGENT_TOOL_APPROVAL_FAIL_OPEN=false`）

### 3.9 任务队列：asynq 七队列 × 五工作池

`types/task.go` 的 `queueDefinitions` 把七类任务映射到五个工作池：

| 池 | 本部署并发 | 承载 |
|---|---|---|
| core | 2 | 文档解析主编排 |
| postprocess | 1 | 解析后处理 |
| enrichment | 2 | 向量化/图谱增强 |
| maintenance | 1 | 巡检回收（housekeeping，回收卡在 processing 的脏数据） |
| shared | 2 | 共享任务（含 chat_attachment，**权重 3**——防止聊天附件被批量导入饿死） |

Redis 中实测仅 45 个键且全部为 asynq 命名空间（`asynq:server:*` 等）——**Redis 在本部署是纯队列/流角色，不缓存业务数据**，重启丢失影响极小。

超时治理三层：文档处理总超时 2h（`WEKNORA_DOCUMENT_PROCESS_TIMEOUT`）> 单次 DocReader RPC 30m > 各解析引擎（MinerU/PaddleOCR-VL/云轮询）各自独立超时。

### 3.10 文档解析：docreader gRPC 服务

独立 Python 容器（62 MiB 常驻），20+ 解析器，gRPC 协议四个核心方法：

- `Read` / `ReadStream`：解析文档，流式返回（含页面图片）
- `ListEngines`：枚举可用解析引擎
- `PreprocessImage`：拍照矫正（几何摆正，17 张图上调好的阈值组，OCR 前置）

解析能力覆盖：PDF（文本层/扫描页自动判定、版式调优、图表区 JPEG 渲染）、Office（docx/xlsx 百分比单元格物化）、HTML（trafilatura 正文抽取可选）、图片 OCR（RapidOCR/PaddleOCR-VL）、OpenDataLoader hybrid。PDF 渲染参数极其细致（DPI 200、JPEG 85、最大边 2000px、字距比 0.4、侧栏丢弃比 0.12……），是长年实战打磨的痕迹。

### 3.11 可选能力（本部署未启用但代码就绪）

- **11 种向量库**：切换只需改 `RETRIEVE_DRIVER`，多驱动可并行（带超时控制）
- **多对象存储**：local / MinIO / 腾讯 COS / AWS S3 / 华为 OBS / 阿里 OSS / 火山 TOS
- **OIDC 单点登录**（Dex 演示配置就绪）
- **Langfuse 可观测**（复用同一 PG/Redis，ClickHouse + MinIO 独立）
- **Docker 沙箱**（默认关闭——注释明确警告「挂载 docker.sock 等同宿主机 root，仅私有化单机」）
- **IM 渠道**：企业微信/飞书/钉钉机器人接入

### 3.12 镜像构建

`docker/Dockerfile.app` 多阶段构建：① `browserskill` 阶段（Node 24 + Rust 工具链编译浏览器扩展，按 TARGETOS/TARGETARCH 交叉编译）→ ② Go builder（golang:1.26-bookworm）→ ③ 运行时（含 WITH_ANYDOC=1 的 AnyDoc 商业解析器开关、构建元数据 VERSION/COMMIT 注入 system-info 页）。前端 Dockerfile 两阶段，builder 用 `$BUILDPLATFORM` 做**架构无关构建**（amd64/arm64 共享同一 dist，CI 不用 qemu 模拟 Node）。

---

## 四、前端架构与技术实现

### 4.1 技术栈

| 层 | 选型 | 版本 |
|---|---|---|
| 框架 | Vue 3（Composition API） | 3.5 |
| 语言 | TypeScript | 6 |
| 构建 | Vite | 7 |
| 状态 | Pinia | 3 |
| 路由 | vue-router | 4 |
| UI 库 | TDesign（腾讯） | 1.19 |
| 国际化 | vue-i18n | 6 语言 |
| SSE | @microsoft/fetch-event-source | — |
| 桌面预览 | @novnc/novnc + @xterm/xterm | 沙箱远程桌面/终端 |
| 虚拟滚动 | vue-virtual-scroller | 长会话列表 |
| 桌面壳预留 | wailsjs（go/runtime 目录已就绪） | Wails 桌面版路径 |

### 4.2 双入口构建（embed 生态）

`vite.config.ts` 构建两个入口：

1. **index.html**：主应用（完整功能）
2. **embed.html**：**可嵌入第三方站点的轻量问答组件**（独立 CSP 策略、裁剪的模块预载、更小的包体）

配套手段：vendor 手动分包（node_modules 按依赖聚合，优化缓存命中）、pdfjs wasm 拷贝插件（PDF 预览的 wasm 资产随 dist 分发）、`VITE_FRONTEND_COMMIT` 注入 system-info 页显示版本。

### 4.3 nginx 网关（前端的「隐形骨架」）

`frontend/nginx.conf` + `nginx-api-proxy.conf` 的完整规则集：

| 规则 | 实现 |
|---|---|
| SPA fallback | `try_files $uri $uri/ /index.html`（前端路由不 404） |
| 静态资产缓存 | `/assets` 一年强缓存（immutable，配合内容哈希文件名） |
| **embed 动态 CSP** | `/embed.html` 独立 internal location → `auth_request` 子请求到后端 `embed-frame-policy` 接口 → **按渠道返回不同的 CSP frame-ancestors**（同一 embed 页面，飞书渠道只许飞书域嵌、Web 渠道只许自家域嵌） |
| SSE 透传 | 代理关闭缓冲（`proxy_buffering off`）、3600s 读超时——流式问答不被网关卡断 |
| WebSocket 升级 | 沙箱远程桌面（noVNC）专用 location，`Upgrade/Connection` 头透传 |
| 上传分档 | 技能包 zip 上传路由独立 `client_max_body_size`（256MB，普通上传 50MB） |
| 资源短链 | `/r/<token>` 供 IM 渠道渲染 `resource://` 图片 |
| 安全响应头 | 标准安全头注入 |

**评价**：这个 nginx 不是简单的「静态文件 + 反代」，而是承担了**渠道策略执行点**（embed CSP）、**协议适配点**（SSE/WS）和**限流分档点**（上传大小）三个网关级职责，配置注释密度极高，是整个前端工程化程度最高的部分。

### 4.4 应用入口与启动时序（main.ts）

```
installTDesignIconOfflineGuard()   # 拦截 tdesign-icons 对 tdesign.gtimg.com 的运行时请求（离线安全）
initTheme() / initFont()
bootstrap():
  createApp → errorHandler（全局错误兜底防白屏）
  app.use(TDesign) → use(pinia)
  localStorage 有 token → await authStore.refreshFromAuthMe()   # 首屏前校准会话与能力位
  → mount
```

细节值得注意：**能力位不缓存 localStorage**，每次有会话的加载都在首绘前与后端对账，防止权限变更后前端展示过期。

### 4.5 路由设计（417 行 router/index.ts）

- 路由守卫做 **Lite 版检测**（编译期 Edition 在后端注入，前端据此裁剪导航）
- **OIDC 回调路由保护**（防中间人截获授权码）
- 会话/知识库/Agent/自动化/设置等全功能域映射

### 4.6 SSE 流式：useStream 组合式函数

`src/api/chat/streame.ts` 的 `useStream`：

- 基于 `@microsoft/fetch-event-source`（对比原生 EventSource：**支持 POST + 自定义 header**，携带 JWT）
- **缓冲渲染**：SSE token 批量入队、按帧冲刷到 UI（高频 token 不触发逐字重排）
- **认证重试**：401 时静默刷新令牌重放请求
- 配合后端 Redis 流管理：断线后走 continue-stream 续传

### 4.7 状态管理

Pinia 3 按域分 store（auth / 会话 / 知识库 / Agent / 系统设置…），auth store 持有 token + 能力位，与会话级 store 解耦。

---

## 五、数据库与存储设计

### 5.1 PostgreSQL（ParadeDB 发行版）

- **镜像**：`paradedb/paradedb:v0.26.4-pg17`（PG 17.11），选定 ParadeDB 的原因是**一个数据库同时提供向量与全文两个引擎**
- **扩展**：`vector`（pgvector）、`pg_search`（ParadeDB 的 BM25）、`pg_trgm`（模糊匹配）、`pg_ivm`（物化视图增量维护）、`postgis`、`uuid-ossp`
- **规模**：123 张表，134 个版本化迁移（000001 → 000134，up/down 成对），`AUTO_MIGRATE=true` 启动时自动执行

### 5.2 核心表与索引（迁移 00-init-db.sql）

```
tenants（租户/空间）─┬─ knowledge_bases ── knowledges（文档，parse_status 状态机）
models（模型目录）  │
sessions ─ messages（会话与消息）
                     └─ chunks（分块：parent_chunk_id 父子链 + chunk_type + 前后链）
                          └─ embeddings（向量：halfvec 列 + dimension 区分）
```

**索引设计是全库精华**——embeddings 表的**三维数 HNSW 部分索引**：

```sql
CREATE INDEX ... USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE (dimension = 1024);
CREATE INDEX ... USING hnsw ((embedding::halfvec(3584)) ...) WHERE (dimension = 3584);
CREATE INDEX ... USING hnsw ((embedding::halfvec(798))  ...) WHERE (dimension = 798);
```

三个维度分别对应三类主流嵌入模型（1024：jina-v3 等；3584：Qwen3-Embedding-4B/8B 系；798：bge-m3 系）。**partial index 的意义**：同一张表混存不同维度向量，每种维度只索引自己的行——换嵌入模型不锁表、不重建全索引；**halfvec（fp16）的意义**：向量存储与索引体积减半，精度损失对检索排序几乎无影响。这是「单库多模型并存」的教科书式方案。

**BM25 全文索引**用 ParadeDB pg_search 的 `chinese_lindera` 分词器（中文友好），与 HNSW 向量索引构成混合检索的两条召回通道——**在同一张表上同时完成向量 + 关键词召回**，这是选择 ParadeDB 而非原生 PG 的决定性理由。

### 5.3 Redis（纯队列/流角色）

- redis:7.0-alpine，`--appendonly yes --requirepass`（AOF 持久化 + 密码）
- 实测 45 个键全部为 asynq 命名空间（队列/调度器/服务器状态）
- `STREAM_MANAGER_TYPE=redis`：SSE 流状态入 Redis（跨进程重放的基础）
- 系统设置 pub/sub 频道（多实例配置同步；Lite 无 Redis 时优雅降级为 no-op）

### 5.4 文件存储

`STORAGE_TYPE=local`，落 `data-files` 卷（/data/files），无对象存储。compose 预置 MinIO/COS/S3/OBS/OSS/TOS 全套切换能力（改环境变量即可）。

---

## 六、模型路由与算力约束（本部署的特殊性）

### 6.1 为什么这样切分

| 环节 | 位置 | 理由 |
|---|---|---|
| LLM/VLM 生成 | 线上 agnes-3.0-flash | 生成模型大、GPU 需求高，8C/15G 的 VM 跑不动；flash 级模型延迟可接受 |
| Embedding | 本地 kb-embed | 嵌入调用量大（批量入库 + 每次查询），走线上既慢又贵；jina-v3 CPU 可跑 |
| Rerank | 本地 kb-embed | 同上；且重排对延迟敏感（在问答链路上） |

### 6.2 kb-embed 容器的约束（历史教训驱动的配置）

- **8 GiB 内存硬上限**：曾因嵌入/重排进程吃满 15.3 GiB 拖垮整机（OOM 连 PostgreSQL 都被杀），遂设硬限
- `RERANK_BATCH=8`：重排批大小限制，防单批大候选集把内存打爆
- 实测常驻 6.2 GiB / 8 GiB（含 jina-v3 + jina-reranker-v2 双模型常驻内存）
- 网络：仅 `127.0.0.1:8088`（回环）+ kbnet 内网别名 `embed`——**宿主机端口扫描不可见**，WeKnora app 通过 kbnet 主机名访问
- SSRF 白名单 `SSRF_WHITELIST=embed`：app 的出站 SSRF 校验放行 embed 主机名（否则内网地址会被自家 SSRF 防护拦截）

### 6.3 并发收紧（8C/15G 的自我保护）

官方默认值面向更大机器（core=8 / enrichment=12 / model=32），本部署全面下调（core=2 / enrichment=2 / model=8 / pool=3），加上 kb-embed 的 8G 上限，**整机能稳定运行在约 7 GiB 常驻 + 峰值约 10 GiB 的水位**。

---

## 七、与 kb-deskpet 的关系与对比

两个系统共享同一台 VM 与同一个 kb-embed 模型服务，但定位完全互补：

| 维度 | WeKnora（VM 端） | kb-deskpet（本机 + VM） |
|---|---|---|
| 定位 | 企业级知识库平台（服务端） | 公司内部知识库的桌宠入口（客户端） |
| 技术栈 | Go 1.26 单体 + Vue 3 SPA | FastAPI + Tauri 桌宠壳 |
| 代码量 | ≈ 31.2 万行 | 轻量级 |
| 检索 | PG 内 HNSW + BM25 双引擎混合、RRF 融合、可选重排 | jieba 预分词 + 向量 + 关键词 RRF 融合、本地重排（失败自动降级）、**确定性拒答闸门**（生成前判定，检索不到就拒答） |
| 权限 | 多租户 RBAC 四级角色 + API Key 三档能力 + KB 白名单 | 部门粒度 SQL 内过滤（ACL 谓词全系统唯一一处） |
| 管道 | 14 事件插件责任链（可插拔） | 固定管线（解析→切片→向量化→入库；检索→融合→重排→拒答→生成） |
| 任务 | Redis + asynq 五池 | PG jobs 表轮询 claim |
| 存储 | ParadeDB PG（123 表）+ 可选 6 种对象存储 | PG/pgvector（9 表）+ 本地 |
| 嵌入/重排 | **共用 kb-embed 容器**（jina-v3 + jina-reranker-v2） | 同左（kb-embed 本属 kb-deskpet 编排） |
| 工程哲学 | 平台化：功能面宽、可配置项极多、多环境适配 | 克制：8 条铁律、「能用 30 行 SQL 解决的不引入中间件」 |

**关系**：kb-embed 容器（`kb-deskpet-embed-1`）本是 kb-deskpet 项目的本地向量化服务，通过 `kbnet` 外部网络 + `embed` 别名"顺便"服务了 WeKnora——**一套本地模型服务，两个系统复用**，这是该 VM 上最经济的设计。若未来 kb-deskpet 的 Tauri 桌宠壳要接服务端，WeKnora 的 410 条 API + API Key 体系是现成的后端。

---

## 八、风险与建议

### 8.1 风险清单（按优先级）

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| 1 | **内存天花板**：kb-embed 6.2/8 GiB，加上五容器 + 系统占用，15.6 GiB 机器无冗余；批量入库时 embed 峰值可能顶到 8G 限被 OOM kill，表现为入库任务批量失败 | 入库不可用 | 已有 RERANK_BATCH=8 + 并发收紧缓解；无告警 |
| 2 | **单点无备份**：postgres-data / data-files 均为本地 Docker 卷，无定期备份策略验证；VM 挂了数据全丢 | 数据丢失 | 未见备份 cron |
| 3 | **SYSTEM_AES_KEY / JWT_SECRET 单点**：丢失即全部加密字段不可恢复（API Key、模型密钥等） | 不可逆 | 密钥在 .env 明文，未见离线备份 |
| 4 | **docreader 无认证**：gRPC 明文无 TLS（依赖网络隔离），同网络的任何容器可调它解析文件 | 内网横向面 | compose 注释已知悉，低风险（单机部署） |
| 5 | **健康端点也需认证**（/api/v1/health 401）：监控探针无法直接使用，需走 /health（容器内 curl） | 可观测性 | docker healthcheck 用容器内 /health，够用 |
| 6 | **版本升级依赖**：v0.9.0 → 未来版本的迁移链长（134 个迁移），AUTO_MIGRATE=true 启动即执行，升级前必须先备份 | 升级风险 | compose 默认行为 |
| 7 | **Redis 单点**：队列 + SSE 流 + pub/sub 全走它，重启期间入库任务暂停、进行中的对话流中断（AOF 可恢复） | 可用性 | appendonly 已开 |
| 8 | **LLM 出网依赖**：agnes-3.0-flash 不可达时所有生成类功能（问答/Agent/助手）不可用，仅检索可用 | 功能降级 | 无降级链 |

### 8.2 建议

1. **立即**：建立 postgres 每日 `pg_dump` + data-files 卷的异地备份（cron + 本机外存储），并把 SYSTEM_AES_KEY/JWT_SECRET 离线抄存
2. **短期**：给 kb-embed 加内存水位告警（如 7.2 GiB 阈值），批量入库任务错峰；考虑 embedding 批量队列限速（BATCH_EMBED_SIZE 已是 8，配合 asynq enrichment 并发 2 已较保守）
3. **短期**：升级前演练——拉新版本镜像到本地 tag、`AUTO_MIGRATE=false` 手动执行迁移、验证后切流
4. **中期**：若 kb-deskpet 桌宠壳上线，建议直接以 WeKnora 为后端（API Key retrieve 能力 + KB 白名单即可收敛权限面），避免重复造服务端
5. **中期**：监控接入——app 的 /health + postgres pg_isready + redis ping + kb-embed 端口探活，四个探针足够覆盖全链路

---

## 九、附录

### 9.1 关键源码路径（VM `~/weknora`）

| 路径 | 内容 |
|---|---|
| `cmd/server/main.go` | 入口（envfile → dig → 优雅关停） |
| `internal/container/container.go` | DI 装配中心（11 向量库 + 9 连接器注册） |
| `internal/types/chat_manage.go:374-387` | 14 种管道事件定义 |
| `internal/application/service/chat_pipeline/` | 插件责任链 |
| `internal/application/service/knowledgebase_search.go:130-215` | HybridSearch 主流程 |
| `internal/application/service/knowledgebase_search_fusion.go` | RRF 融合与归一化 |
| `internal/types/tenant_member.go` | TenantRole 四级角色 |
| `internal/middleware/access.go` / `rbac.go` | 租户访问与角色守卫 |
| `internal/types/task.go` | asynq 队列/池定义 |
| `internal/agent/engine.go` + `agent/tools/` | ReAct 引擎 + 92 工具 |
| `migrations/paradedb/00-init-db.sql` | 建库脚本（三维数 HNSW + BM25） |
| `frontend/vite.config.ts` | 双入口构建 |
| `frontend/nginx.conf` + `nginx-api-proxy.conf` | 网关全规则 |

### 9.2 审计数据存档

- 编排文件副本：`deliverables/weknora-analysis/audit-data/docker-compose.yml.txt`
- 审计方法：SSH ControlMaster 复用连接（防 fail2ban）+ 源码 grep/阅读 + `docker stats`/`docker logs` 实测 + psql/redis-cli 直查

### 9.3 v0.9.0 版本特性（CHANGELOG 摘要）

WeKnora 助手（内置工作台助手，可建 Agent/排任务/管知识库/诊断）、多智能体协作（持久子任务、独立会话、实时进度）、自动化（一次性/周期调度、时区校验、错过策略、审批管理）、权限与审批三档（只读/确认后改/自动写 + HITL）、沙箱分配（按用户复用机器、会话工作目录、空闲保留）、后台 shell（异步执行/增量输出/等待取消）、图像管线（手动/智能 OCR 管线）、数据源深化（飞书块解析、钉钉文件夹、Confluence PAT）、检索增强（RRF 设置暴露、独立知识图谱 JSON API）、工作台默认模型（六类模型 + 默认搜索供应商）。
