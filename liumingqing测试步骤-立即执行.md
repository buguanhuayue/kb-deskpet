# liumingqing 问题测试步骤（立即执行）

## 准备工作
服务器：192.168.1.234
账号：demo / Demo@12345

## 步骤 1：SSH 连接服务器
```bash
ssh demo@192.168.1.234
# 输入密码：Demo@12345
```

## 步骤 2：检查 liumingqing 用户状态
```bash
cd ~/weknora

# 查找用户信息
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT id, email, name, created_at FROM users 
   WHERE name LIKE '%liuming%' OR email LIKE '%liuming%' 
   ORDER BY created_at DESC LIMIT 5;"
```

记录下用户的 **id** 和 **email**，后续需要用。

## 步骤 3：检查该用户的知识库
```bash
# 替换 <用户ID> 为上一步得到的 ID
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT kb.id, kb.name, kb.status, kb.chunk_count, kb.created_at
   FROM knowledge_bases kb
   WHERE kb.created_by = '<用户ID>'
   ORDER BY kb.created_at DESC
   LIMIT 10;"
```

**观察结果**：
- 如果返回 **0 行**：用户从未上传过文档 → 执行步骤 4
- 如果有知识库，检查 `status` 列：
  - `status = 'ready'` 且 `chunk_count > 0`：文档正常 → 执行步骤 5
  - `status = 'failed'`：文档处理失败 → 执行步骤 6

## 步骤 4：用户无文档 - 创建测试文档
```bash
# 创建一个测试文本文件
cat > /tmp/test_magpie.txt << 'TESTDOC'
magpie 测试文档

这是为 liumingqing 用户创建的测试文档。

magpie 项目的主要功能包括：
1. 知识库管理
2. 文档搜索
3. 智能问答

联系人：张三，电话：13800138000
TESTDOC

echo "测试文件已创建：/tmp/test_magpie.txt"
```

**现在需要手动操作**：
1. 浏览器访问：https://knowledge.xinyeonline.com.cn
2. 用 liumingqing 账号登录
3. 上传 `/tmp/test_magpie.txt` 文件
4. 等待处理完成（状态变为 "已完成"）
5. 搜索："帮我看一下 magpie 存入了哪些内容"
6. 检查是否还报 2201 错误

## 步骤 5：知识库正常但搜索失败 - 检查向量
```bash
# 替换 <知识库ID> 为步骤 3 得到的第一个知识库 ID
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT COUNT(*) as total_chunks,
          COUNT(embedding) as with_embedding,
          COUNT(*) - COUNT(embedding) as missing_embedding
   FROM knowledge_base_chunks
   WHERE kb_id = '<知识库ID>';"
```

**结果分析**：
- `missing_embedding = 0`：所有分片都有向量，问题不在这里
- `missing_embedding > 0`：部分分片缺少向量 → 需要重新处理

**重新处理方法**：
在 WeKnora 管理界面找到该知识库，点击"重新处理"或"重新索引"。

## 步骤 6：文档处理失败 - 查看错误
```bash
# 替换 <知识库ID> 为失败的知识库 ID
docker compose exec -T postgres psql -U weknora -d weknora -c \
  "SELECT id, name, status, error_message, updated_at
   FROM knowledge_bases
   WHERE id = '<知识库ID>';"
```

**根据 error_message 处理**：
- 包含 "embed" / "vector"：embed 服务之前不可用 → 删除重新上传
- 包含 "parse" / "format"：文件格式问题 → 检查原文件
- 其他错误：记录错误信息，联系技术支持

## 步骤 7：查看实时日志（如果还有问题）
```bash
cd ~/weknora

# 在一个终端窗口持续查看日志
docker compose logs -f app

# 然后在浏览器用 liumingqing 账号搜索
# 观察日志中是否出现错误
```

## 步骤 8：终极测试 - 直接 API 调用
```bash
# 获取 liumingqing 的 token（需要先登录 Web 界面，从浏览器开发者工具获取）

# 测试向量化服务
curl -X POST http://localhost:8090/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jinaai/jina-embeddings-v3",
    "input": ["测试 magpie"]
  }'

# 应该返回 1024 维向量
```

## 快速判断表

| 现象 | 原因 | 解决方法 |
|------|------|----------|
| 步骤3返回0行 | 用户无文档 | 执行步骤4上传测试文档 |
| status='failed' | 文档处理失败 | 删除后重新上传 |
| missing_embedding>0 | 缺少向量 | 在界面重新处理 |
| 所有检查正常但还报错 | 查询权限/配置问题 | 查看步骤7实时日志 |

## 预期结果
✅ liumingqing 用户能成功搜索并看到结果
✅ 不再出现 "error code: 2201" 错误
✅ 能看到引用的文档片段和来源

---

执行人：_______
执行时间：_______
结果：□ 成功  □ 失败（错误信息：_______________）
