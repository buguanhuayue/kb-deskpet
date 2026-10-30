# kb-deskpet

公司内部知识库（桌宠入口）—— **P0 文本闭环**骨架：上传 PDF/TXT → 混合检索 → 带页码引用的回答。

方案与实施计划在 `~/WorkBuddy/本地部署dify/公司内部知识库_*.md`，本仓库是它的落地代码。
进度与技术说明（汇报用）见 [docs/进度与技术说明.md](docs/进度与技术说明.md)。

## 三步跑起来

```bash
cp .env.example .env
# 填三个 key：LLM_API_KEY(Agnes) / EMBED_API_KEY(硅基流动) / RERANK_API_KEY(可空)

make up        # postgres + api + worker
make check     # M0 闸门：不回全绿就别往下走
make seed      # 打印 token，贴到验收台
open http://localhost:8088
```

## 现在支持什么

| 能力 | 状态 |
|---|---|
| PDF / TXT / MD / CSV 入库 | ✅ |
| 中文分词 + 向量 + RRF 混合检索 | ✅ |
| 重排（失败自动降级） | ✅ |
| 带页码引用、检索不到就拒答 | ✅ |
| 部门粒度权限（SQL 内过滤） | ✅ 基础版 |
| Word / Excel / PPT / 图片 / 视频 | ⏳ P1 |
| 条目审核台、审计、体检 | ⏳ P2 |
| 桌宠壳（Tauri） | ⏳ P1 末 |

## 目录

```
server/app/
  api/       路由（ingest / query / meta）
  ingest/    解析 → 切片 → 向量化（worker 侧）
  search/    检索 SQL / 融合 / 重排 / 拒答闸门
  services/  embedding / rerank / llm / storage（外部依赖都在这里，换供应商只改这一层）
migrations/  纯 SQL 迁移，按文件名顺序执行
```

## 关键参数在哪改

- 切片粒度：`app/ingest/chunker.py` 顶部三个常量（改完必须跑 eval）
- 融合权重：`RRF_K`（.env）
- 拒答阈值：`NOT_FOUND_THRESHOLD`（.env）
- 中文分词：`app/search/tokenize.py`（入库和查询共用，改一处等于全改）
