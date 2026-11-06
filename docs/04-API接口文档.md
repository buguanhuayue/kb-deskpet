# 04 · API 接口文档

> 面向：前端开发、集成方。
> 基线：`http://<host>:9527`。所有业务接口前缀 `/api`。

## 一、鉴权

除 `/api/health` 与静态页外，**所有接口都需要 Bearer Token**：

```
Authorization: Bearer <token>
```

- Token 存在 `users.api_token` 字段，由 `scripts/seed.py` 生成，或手工写库
- 无 Token / Token 无效 → `401`
- P0 无过期机制、无刷新、无 SSO。接 SSO 后此字段作废（见 [08](08-已知限制与风险.md)）

## 二、错误响应格式

FastAPI 会把 `HTTPException` 的 detail 包在 `detail` 里，实际收到的是**嵌套结构**：

```json
{
  "detail": {
    "code": "bad_token",
    "message": "token 无效"
  }
}
```

前端判断请用 `detail.code`，不要用 `message`（可能随文案调整）。

### 错误码总表

| HTTP | code | 触发条件 | 建议处置 |
|---|---|---|---|
| 400 | `no_dept` | 账号未分配部门 | 联系管理员分配部门 |
| 400 | `bad_visibility` | `visibility` 不是 private/dept/company | 检查参数 |
| 400 | `empty` | `question` 或 `content` 为空 | 检查参数 |
| 400 | `too_long` | 问题超过 1000 字 | 拆短问题 |
| 400 | `bad_subject_type` | ACL 的 `subject_type` 不是 user/dept | 检查参数 |
| 400 | `bad_uuid` | ACL 的 `subject_id` 不是合法 uuid | 检查参数 |
| 400 | `bad_permission` | ACL 的 `permission` 不是 read | 检查参数 |
| 401 | `no_token` | 缺少 Authorization 头 | 补 Token |
| 401 | `bad_token` | Token 不存在 | 重新签发 |
| 403 | `forbidden` | 已登录但无权操作（如非 owner 改 ACL） | 找文档所有者或管理员 |
| 404 | `not_found` | 文档 ID 不存在 | 检查 doc_id |
| 404 | `subject_not_found` | ACL 授权目标（用户/部门）不存在 | 检查 subject_id |
| 413 | `too_large` | 文件超过 `MAX_UPLOAD_MB` | 压缩或调整上限 |
| 415 | `unsupported` | 扩展名不在 pdf/txt/md/csv | 转换格式 |

> `401` = 没登录（缺 Token / Token 无效）；`403` = 登录了但没这个权限。
> 两者不要混用，前端据此决定是跳登录页还是提示"没权限"。

## 三、接口清单

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/` | 单页验收台 | 否 |
| GET | `/api/health` | 健康检查 | 否 |
| GET | `/api/me` | 当前用户信息 | 是 |
| GET | `/api/documents` | 文档列表（最近 100） | 是 |
| GET | `/api/documents/{doc_id}` | 单个文档详情 | 是 |
| POST | `/api/documents/{doc_id}/acl` | 给某人/某部门显式授权该文档 | 是（owner / admin） |
| DELETE | `/api/documents/{doc_id}/acl` | 撤销显式授权 | 是（owner / admin） |
| GET | `/api/documents/{doc_id}/acl` | 列出该文档的显式授权 | 是（owner / admin） |
| POST | `/api/ingest/file` | 上传文件入库 | 是 |
| POST | `/api/ingest/text` | 纯文本入库 | 是 |
| POST | `/api/query` | 问答（SSE 流式） | 是 |
| POST | `/api/search` | 只检索不生成（调参/评测用） | 是 |

---

## 四、GET /api/health

无鉴权。**注意：它只表示"配置存在"，不代表"服务真的调得通"**——
`embed: configured` 的含义是"key 填了"，不是"向量服务在响应"。
要真实探活请查 embed 容器的 `/health`（端口 8090）或跑 `scripts/check_keys.py`。

```json
{
  "db": "ok",
  "embed": "configured",
  "rerank": "configured",
  "llm": "configured",
  "embed_model": "jinaai/jina-embeddings-v3",
  "llm_model": "agnes-3.0-flash"
}
```

`db` 为 `down: <错误>` 表示数据库连接失败，其余三项为 `missing_key` 表示未配置。

---

## 五、GET /api/me

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9527/api/me
```

```json
{
  "id": "e0a1...",
  "email": "admin@local",
  "name": "演示管理员",
  "dept_id": "b2c3...",
  "role": "admin"
}
```

`dept_id` 可能为 `null`，此时**不能入库**（返回 `400 no_dept`），但可以提问（查不到任何东西，
因为权限谓词依赖部门）。

---

## 六、GET /api/documents

返回当前用户可见的文档（自己拥有的 + 同部门且非私有的），按创建时间倒序，上限 100。

```json
{
  "items": [
    {
      "id": "175cf1f7-...",
      "title": "差旅与休假制度",
      "status": "ready",
      "chunk_count": 12,
      "bytes": 184320,
      "created_at": "2026-10-30T10:12:33.123456+00:00",
      "error_msg": null
    }
  ]
}
```

`status` 取值：`uploaded` → `parsing` → `chunking` → `embedding` → `ready` / `failed`。
前端轮询此接口即可画进度条。

---

## 七、GET /api/documents/{doc_id}

```json
{
  "id": "175cf1f7-...",
  "title": "差旅与休假制度",
  "status": "failed",
  "chunk_count": 0,
  "bytes": 184320,
  "created_at": "...",
  "error_code": "embed_failed",
  "error_msg": "向量维度不匹配：期望 1024，实际 768",
  "ext": {}
}
```

**注意：此接口未做权限过滤**（仅需登录），任何登录用户知道 doc_id 就能查到元信息。
P0 已知问题，见 [08](08-已知限制与风险.md#三安全相关的已知问题)。

---

## 八、ACL 显式授权（按人 / 按部门）

三档可见性（private / dept / company）之外，还可以对**某个人**或**某个部门**
做单文档的显式授权，授权后对方即可检索到该文档内容（FR-28）。

三个端点都挂在 `/api/documents/{doc_id}/acl` 上，**只有该文档的 owner 或
admin 角色的账号能调用**；其他人一律返回 `403 forbidden`。
这是硬约束：`acl.subject_id` 没有外键约束，写入端必须自己把关，
否则普通用户可以把自己塞进任意文档的授权名单里（自我提权）。

| 方法 | 用途 | 请求体 |
|---|---|---|
| POST | 授权 | `{"subject_type":"user","subject_id":"<uuid>","permission":"read"}` |
| DELETE | 撤销授权 | `{"subject_type":"user","subject_id":"<uuid>"}` |
| GET | 列出该文档的授权记录 | 无 |

| 字段 | 必填 | 说明 |
|---|---|---|
| `subject_type` | 是 | `user`（按人）或 `dept`（按部门），必须与 acl 表 CHECK 约束一致 |
| `subject_id` | 是 | 目标用户或部门的 uuid，必须真实存在，否则 `404 subject_not_found` |
| `permission` | 否 | 本版只支持 `read`，缺省即 `read`；其他值返回 `400 bad_permission` |

### 授权（POST）

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"subject_type":"dept","subject_id":"b2c3...","permission":"read"}' \
  http://127.0.0.1:9527/api/documents/175cf1f7-.../acl
```

```json
{
  "doc_id": "175cf1f7-...",
  "subject_type": "dept",
  "subject_id": "b2c3...",
  "permission": "read"
}
```

重复授权同一个人/部门是**幂等**的：不会报错，会把 permission 更新为新值。

### 撤销授权（DELETE）

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"subject_type":"dept","subject_id":"b2c3..."}' \
  http://127.0.0.1:9527/api/documents/175cf1f7-.../acl
```

```json
{
  "doc_id": "175cf1f7-...",
  "subject_type": "dept",
  "subject_id": "b2c3...",
  "revoked": true
}
```

撤销也是幂等的：本来就没有这条授权时同样返回成功（撤销是清理动作）。

### 查看授权列表（GET）

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9527/api/documents/175cf1f7-.../acl
```

```json
{
  "doc_id": "175cf1f7-...",
  "items": [
    {"subject_type": "dept", "subject_id": "b2c3...", "permission": "read", "subject_name": "财务部"},
    {"subject_type": "user", "subject_id": "d4e5...", "permission": "read", "subject_name": "张三"}
  ]
}
```

`subject_name` 是目标的用户名 / 部门名，方便前端直接展示；
目标已被删除时为 `null`。

### 生效条件与注意事项

- 授权记录落在 `acl` 表，检索链路的可见性谓词（`search/sql.py::ACL`）会直接命中它
  ——**不需要重新入库，也不需要改文档的 visibility**。
- 授权只影响**检索可见性**；`GET /api/documents`（列表）仍按 owner / 同部门 / 非 private
  的老口径返回，不含"靠 ACL 授权进来"的文档。
- 撤销授权后，被授权方立即搜不到该文档（谓词在 SQL 里实时判定，无缓存）。
- 本版只支持 `read`；`edit`（可写）语义尚未定义，传 `write` 会被 `400` 拒绝。

---

## 九、POST /api/ingest/file

上传文件入库。`multipart/form-data`。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `file` | 是 | 文件 | 支持 `.pdf` `.txt` `.md` `.csv` |
| `title` | 否 | string | 缺省用文件名 |
| `visibility` | 否 | string | `private` / `dept`（默认） / `company` |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@制度.pdf" -F "title=差旅与休假制度" -F "visibility=dept" \
  http://127.0.0.1:9527/api/ingest/file
```

**首次入库**

```json
{ "doc_id": "175cf1f7-...", "status": "uploaded", "bytes": 184320, "deduped": false }
```

**重复上传（同部门、内容完全相同）**

```json
{ "doc_id": "175cf1f7-...", "status": "ready", "deduped": true }
```

去重基于 `sha256`，作用域是**同部门**。跨部门上传同一文件会各自入库。
注意：**内容改了一个字节就不会命中去重**，会新增一篇而不是覆盖旧版。

上传成功后仅代表文件落盘 + 建任务，**解析与向量化是异步的**，需轮询
`/api/documents` 等状态变 `ready`（worker 空闲轮询间隔 2 秒）。

---

## 十、POST /api/ingest/text

纯文本入库，适合"随手记"场景。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"打印机位置","content":"打印机在 3 楼东侧，坏了自己换硒鼓。","visibility":"dept"}' \
  http://127.0.0.1:9527/api/ingest/text
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `content` | 是 | 正文，不能为空 |
| `title` | 否 | 缺省为「随手记 N 字」 |
| `visibility` | 否 | 同上传接口 |

```json
{ "doc_id": "...", "status": "uploaded" }
```

---

## 十一、POST /api/query（SSE 流式）

问答主接口，返回 `text/event-stream`。

```bash
curl -sN -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"住宿费的报销标准是多少？"}' \
  http://127.0.0.1:9527/api/query
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `question` | 是 | 1–1000 字 |

### 事件协议

响应体是标准 SSE，每个事件形如 `event: <name>\ndata: <json>\n\n`。

| 事件 | 时机 | data 结构 |
|---|---|---|
| `retrieval` | **最先**发出 | `{"count": 1, "top_score": 0.7574}` |
| `token` | 逐字/逐块 | `{"delta": "住宿费"}` |
| `citations` | 生成结束后 | 引用数组（见下） |
| `done` | **最后** | `{"refused": false}` |
| `error` | 生成异常 | `{"message": "生成失败: ..."}` |

**拒答时的事件序列**（无 token 流，只有一次完整文本）：

```
event: retrieval   {"count": 1, "top_score": 0.1752}
event: token       {"delta": "知识库里没有查到相关内容。可以换个说法再问，或者把这部分资料先传上来。"}
event: citations   []
event: done        {"refused": true}
```

### citations 数组元素

```json
{
  "index": 1,
  "doc_id": "175cf1f7-...",
  "title": "差旅与休假制度",
  "locator": {"page": 1},
  "locator_text": "第 1 页",
  "snippet": "住宿费报销标准为每晚上限五百元，超标部分自理…",
  "score": 0.7574
}
```

- `index` 对应答案正文里的 `[1]`、`[2]`
- `locator` 是机器可读定位：PDF 为 `{"page": n}`；纯文本为 `{"start": 字节, "end": 字节}`
- `locator_text` 是给人看的：`第 1 页` 或 `00:12–00:35`
- `snippet` 截断 160 字，用于悬浮预览

### 前端接入要点

```js
const res = await fetch('/api/query', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ question })
});
// 注意：必须逐块解析，不能用 res.json()
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  // 按 \n\n 切分事件，解析 event:/data: 两行
}
```

**常见坑**：
- 用 `EventSource` 不行——它只支持 GET，本接口是 POST。要么用 `fetch` + 流式读取，要么引 `@microsoft/fetch-event-source`
- 反向代理必须关闭缓冲。接口已发 `X-Accel-Buffering: no`，但 **Nginx 仍需显式 `proxy_buffering off;`**，否则会攒一堆才吐

---

## 十二、POST /api/search（只检索不生成）

调参与评测专用，返回结构与 `citations` 类似但含全部中间分数。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"住宿费标准"}' http://127.0.0.1:9527/api/search
```

```json
{
  "count": 1,
  "hits": [
    {
      "doc_id": "...",
      "title": "差旅与休假制度",
      "text": "住宿费报销标准为每晚上限五百元，超标部分自理。",
      "locator": {"page": 1},
      "rrf": 0.0328,
      "cosine": 0.6123,
      "rerank": 0.7574
    }
  ]
}
```

三个分数的含义，排障时很有用：

| 字段 | 含义 | 异常表现 |
|---|---|---|
| `rrf` | 双路融合分（倒数排名融合） | 接近 0 说明两路都没召回到它 |
| `cosine` | 向量余弦相似度 | 高但 `rerank` 低 → 语义相近但实际不相关，**正常现象** |
| `rerank` | 重排分，**拒答判定就靠它** | 为 `null` 说明重排服务不可用，已降级 |

---

## 十三、调用示例（完整一次）

```bash
TOKEN=9gDXhxOD81yF_Ng4YBVbzFRG86o2leMq
BASE=http://127.0.0.1:9527

# 1. 确认身份
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/me | python3 -m json.tool

# 2. 上传
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@制度.pdf" $BASE/api/ingest/file

# 3. 等 ready
watch -n2 "curl -s -H 'Authorization: Bearer $TOKEN' $BASE/api/documents | python3 -c \
  'import sys,json;print([(i[\"title\"],i[\"status\"],i[\"chunk_count\"]) for i in json.load(sys.stdin)[\"items\"]])'"

# 4. 提问（只看结论和引用）
curl -sN -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"住宿费标准"}' $BASE/api/query | grep -A1 -E "citations|done"
```

交互式接口文档由 FastAPI 自动生成：`http://<host>:9527/docs`（Swagger UI）、
`/redoc`。可直接在页面上试调，比看文档快。
