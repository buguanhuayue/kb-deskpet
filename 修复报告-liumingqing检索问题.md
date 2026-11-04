# liumingqing 账号检索失败问题修复报告

## 问题现象
用户 `liumingqing` 查询时返回错误：
```
error code: 2201, error message: vector retrieval failed for one or more bound stores
```

## 根本原因
`.env` 配置错误导致向量检索服务不可用：

1. **配置指向云端 API 但无密钥**：
   - `EMBED_BASE=https://api.siliconflow.cn/v1`（云端硅基流动）
   - `EMBED_API_KEY=`（**空**）
   
2. **向量检索被禁用**：
   - `config.py:45` 判定 `embed_enabled = False`
   - 检索降级为 `KEYWORD_ONLY` 模式
   
3. **SQL 仍访问 embedding 列**：
   - 即使降级，`KEYWORD_ONLY` SQL 仍包含 `c.embedding` 引用
   - PostgreSQL pgvector 因配置问题抛出 **2201 错误**

## 解决方案

### 已修复
修改 `.env` 文件，改用**本地 embed 服务**（Docker Compose 已配置）：

```bash
# 向量化
EMBED_BASE=http://embed:8088/v1
EMBED_MODEL=jinaai/jina-embeddings-v3
EMBED_API_KEY=local

# 重排
RERANK_BASE=http://embed:8088/v1
RERANK_MODEL=jinaai/jina-reranker-v2-base-multilingual
RERANK_API_KEY=local
```

### 需要执行
```bash
# 重启服务使配置生效
make down
make up

# 等待 embed 服务启动（首次需下载 2GB 模型，约 5-10 分钟）
make check  # 等待 embed 状态变为 'configured'

# 如果数据库中已有文档但 embedding 为 NULL，需重新处理
# 查询受影响文档数量：
docker compose exec postgres psql -U kb -d kb -c \
  "SELECT COUNT(*) FROM chunks WHERE embedding IS NULL;"

# 如果有，需重新上传或触发重新处理
```

## 验证步骤

1. **检查服务状态**：
   ```bash
   curl http://localhost:9527/api/health
   # 应返回：{"db":"ok","embed":"configured"}
   ```

2. **测试向量化**：
   ```bash
   curl -X POST http://localhost:8090/v1/embeddings \
     -H "Authorization: Bearer local" \
     -H "Content-Type: application/json" \
     -d '{"model":"jinaai/jina-embeddings-v3","input":["测试文本"]}'
   # 应返回 1024 维向量
   ```

3. **检查 chunks 表**：
   ```bash
   docker compose exec postgres psql -U kb -d kb -c \
     "SELECT COUNT(*) as total, 
             COUNT(embedding) as with_vec 
      FROM chunks;"
   # with_vec 应该 > 0
   ```

4. **用 liumingqing 账号测试搜索**：
   - 登录验收台
   - 搜索："帮我看一下 magpie 存入了哪些内容"
   - 应正常返回结果，不再报 2201 错误

## 后续建议

1. **文档重新入库**（如果之前上传失败）：
   - 之前上传的文档可能 `status='failed'` 或 `embedding IS NULL`
   - 建议删除并重新上传

2. **监控 embed 服务**：
   - 本地服务首次启动需下载模型（~2GB）
   - 日志：`docker compose logs embed -f`
   - 健康检查：`/api/health` 接口

3. **生产环境配置**：
   - 如需高并发，考虑扩容 embed 服务副本
   - 或切换到云端 API（需购买 API key）

---

修复时间：2026-11-04
修复人：Claude (lgf)
