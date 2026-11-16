#!/usr/bin/env bash
# 清理 WeKnora 里「已软删但永远没人收尸」的知识及其残留数据。
#
# 背景（2026-11-16 实测，WeKnora v0.9.0，upstream main 同段代码零差异）：
#   DELETE /api/v1/knowledge/:id 走的是软删 —— 行留在 knowledges 里，
#   parse_status 永久停在 'deleting'，deleted_at 非空；GORM 默认作用域
#   （WHERE deleted_at IS NULL）让同一个 id 第二次删除必返 404 code=1003。
#   上游没有回收器，于是这些行 + 它们的 chunks / embeddings 永久占库。
#
# 影响面：
#   - 库里堆垃圾（本次 173 条知识 / 161 切片 / 2 条向量 / 752 条处理跨度）
#   - 用户重复点「移除」只能拿到 404（客户端已按幂等处理，这里只清存量）
#   - 检索不会泄漏：实测召回第 1 名的已删切片最终没进引用（上游按 knowledge 过滤）
#
# 用法：
#   ./purge-soft-deleted.sh              # 干跑：只统计，最后 ROLLBACK
#   ./purge-soft-deleted.sh --apply      # 真删（会先打印备份命令提示）
#   AGE_MIN=1440 ./purge-soft-deleted.sh # 只清软删超过 24 小时的（默认 10 分钟）
#
# 依赖：docker、WeKnora-postgres 容器在跑。

set -euo pipefail

CT="${CT:-WeKnora-postgres}"
DB="${DB:-weknora}"
DB_USER="${DB_USER:-weknora}"
AGE_MIN="${AGE_MIN:-10}"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

qs() { docker exec -i "$CT" psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

echo "[$(date '+%F %T')] WeKnora 软删数据回收  db=$DB age>=${AGE_MIN}min apply=$APPLY"

# 先给一份基线，删完对照
echo "--- 清理前 ---"
qs <<'SQL'
select 'knowledges(软删)' t, count(*) from knowledges where deleted_at is not null
union all select 'chunks(软删知识的)', count(*) from chunks
  where knowledge_id in (select id from knowledges where deleted_at is not null)
union all select 'embeddings(软删知识的)', count(*) from embeddings
  where knowledge_id in (select id from knowledges where deleted_at is not null)
union all select 'embeddings(孤儿)', count(*) from embeddings e
  where not exists (select 1 from knowledges k where k.id = e.knowledge_id)
union all select 'spans(软删知识的)', count(*) from knowledge_processing_spans
  where knowledge_id in (select id from knowledges where deleted_at is not null);
SQL

if [[ -n "$(qs -t -A -c "select 1 from knowledges where deleted_at is not null and deleted_at < now() - make_interval(mins => $AGE_MIN) limit 1")" ]]; then
  if [[ $APPLY -eq 1 ]]; then
    echo "--- 执行删除（事务） ---"
    FINAL="COMMIT"
  else
    echo "--- 干跑（事务最后 ROLLBACK，不落盘） ---"
    FINAL="ROLLBACK"
  fi

  qs <<SQL
BEGIN;

create temp table _pids on commit drop as
  select id from knowledges
   where deleted_at is not null
     and deleted_at < now() - make_interval(mins => $AGE_MIN);

create temp table _cids on commit drop as
  select id from chunks where knowledge_id in (select id from _pids);

\echo '待删条目：'
select 'knowledges' t, count(*) from _pids
union all select 'chunks', count(*) from _cids
union all select 'embeddings(按知识)', count(*) from embeddings where knowledge_id in (select id from _pids)
union all select 'embeddings(按切片)', count(*) from embeddings where chunk_id in (select id from _cids)
union all select 'spans', count(*) from knowledge_processing_spans where knowledge_id in (select id from _pids);

-- 子表先走：向量 → 图片/修订/标签/记忆亲和 → 切片 → 处理跨度 → 知识行
delete from embeddings where knowledge_id in (select id from _pids)
                          or chunk_id in (select id from _cids);
delete from chunk_images where knowledge_id in (select id from _pids);
delete from chunk_revisions where knowledge_id in (select id from _pids);
delete from knowledge_tag_relations where knowledge_id in (select id from _pids);
delete from memory_doc_affinity where knowledge_id in (select id from _pids);
delete from chunks where knowledge_id in (select id from _pids);
delete from knowledge_processing_spans where knowledge_id in (select id from _pids);
delete from knowledges where id in (select id from _pids);

$FINAL;
SQL
else
  echo "没有超过 ${AGE_MIN} 分钟的软删数据，跳过。"
fi

# 孤儿数据：知识行早就不在了（历史版本硬删过），向量/切片留在索引里永远没人认领。
# 这段与软删无关，每次都要跑 —— 旧库（10-31 那批测试库）里就有 9 条这种向量。
if [[ -z "${FINAL:-}" ]]; then
  if [[ $APPLY -eq 1 ]]; then FINAL="COMMIT"; else FINAL="ROLLBACK"; fi
fi
echo "--- 孤儿数据（知识行已不存在） ---"
qs <<SQL
BEGIN;
\echo '待删孤儿：'
select 'embeddings' t, count(*) from embeddings e
  where not exists (select 1 from knowledges k where k.id = e.knowledge_id)
union all select 'chunks', count(*) from chunks c
  where not exists (select 1 from knowledges k where k.id = c.knowledge_id);
delete from embeddings e where not exists (select 1 from knowledges k where k.id = e.knowledge_id);
delete from chunks c where not exists (select 1 from knowledges k where k.id = c.knowledge_id);
$FINAL;
SQL

echo "--- 清理后 ---"
qs <<'SQL'
select 'knowledges(软删)' t, count(*) from knowledges where deleted_at is not null
union all select 'chunks(软删知识的)', count(*) from chunks
  where knowledge_id in (select id from knowledges where deleted_at is not null)
union all select 'embeddings(孤儿)', count(*) from embeddings e
  where not exists (select 1 from knowledges k where k.id = e.knowledge_id);
SQL

echo "[$(date '+%F %T')] 完成"
