# WeKnora 线上问题诊断与修复方案

## 问题现象
用户 `liumingqing` 查询时返回错误：
```
error code: 2201, error message: vector retrieval failed for one or more bound stores
```

## 已确认的正常状态
✅ embed 服务运行正常：
- 容器状态：Up 16 hours (healthy)
- 健康检查：embed_ready=true, rerank_ready=true
- 模型：jinaai/jina-embeddings-v3 (1024维)

✅ 配置正确：
```bash
EMBEDDING_BASE_URL=http://embed:8088/v1
EMBEDDING_API_KEY=not-needed
EMBEDDING_MODEL_NAME=jinaai/jina-embeddings-v3
```

## 可能的原因

### 原因1：用户没有可访问的文档
liumingqing 账号可能：
- 没有上传过任何文档
- 没有被分享任何文档
- 部门权限配置问题

### 原因2：文档存在但没有向量
之前可能：
- embed 服务未启动时上传了文档
- 文档处理失败，status=failed
- chunks 表中 embedding 字段为 NULL

### 原因3：检索配置问题
WeKnora 内部可能：
- 向量检索开关未开启
- 数据源配置错误
- 权限过滤 SQL 有问题

## 诊断步骤

### 步骤1：检查 liumingqing 用户的文档
```bash
ssh demo@192.168.1.234
cd ~/weknora

# 查看用户 ID
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT id, email, name FROM users WHERE email LIKE '%liumingqing%' OR name LIKE '%liumingqing%';"

# 假设用户 ID 是 xxx，查看该用户的文档
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT * FROM knowledge_bases WHERE created_by = '<用户ID>' LIMIT 5;"
```

### 步骤2：检查知识库和分片状态
```bash
# 查看所有知识库
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT id, name, status, created_by FROM knowledge_bases ORDER BY created_at DESC LIMIT 10;"

# 查看知识库的分片（假设知识库 ID 是 xxx）
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT COUNT(*) as total_chunks FROM knowledge_base_chunks WHERE kb_id = '<知识库ID>';"
```

### 步骤3：检查向量字段
```bash
# WeKnora 的向量可能在 knowledge_base_chunks 表的 embedding 字段
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "\d+ knowledge_base_chunks;" | grep embedding
```

### 步骤4：查看应用日志
```bash
cd ~/weknora
docker compose logs app --tail 200 | grep -i "liumingqing\|2201\|vector\|embed"
```

## 快速修复方案

### 方案A：重新上传测试文档
1. 用 liumingqing 账号登录 https://knowledge.xinyeonline.com.cn
2. 上传一个测试文档（PDF 或 TXT）
3. 等待处理完成
4. 再次搜索测试

### 方案B：检查并修复已有文档
如果发现文档存在但没有向量：

```bash
# 1. 找到处理失败的知识库
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT id, name, status FROM knowledge_bases WHERE status = 'failed';"

# 2. 在 WeKnora 管理界面重新处理
# 或通过 API 触发重新处理
```

### 方案C：检查用户权限
```bash
# 查看用户的部门/组织
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT u.id, u.email, u.name, t.name as tenant_name 
   FROM users u 
   LEFT JOIN tenants t ON u.tenant_id = t.id 
   WHERE u.email LIKE '%liumingqing%';"

# 查看该用户可访问的知识库
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT kb.id, kb.name, kb.status 
   FROM knowledge_bases kb
   WHERE kb.created_by = '<用户ID>' 
      OR kb.id IN (SELECT kb_id FROM kb_permissions WHERE user_id = '<用户ID>');"
```

## 紧急联系方式

如果以上步骤无法解决，请：
1. 导出完整日志：`docker compose logs app > app.log`
2. 导出数据库结构：`docker compose exec postgres pg_dump -U weknora -d weknora --schema-only > schema.sql`
3. 联系 WeKnora 技术支持

---

诊断时间：2026-11-04
服务器：192.168.1.234 (knowledge.xinyeonline.com.cn)
