#!/usr/bin/env bash
# 在源机（当前 Mac）执行：打包成"一个 tgz"，拷到虚拟机后一条命令起服务。
#
#   bash deploy/pack.sh            # 产物：dist/kb-deskpet-migrate-<日期>.tgz
#
# 包里有什么：完整仓库（含 .git 历史，320KB 级别）+ .env + 可选数据库 dump。
# 不含：.venv / server/data / dist / 上传的原始文件。
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

STAMP="$(date +%Y%m%d-%H%M)"
DIST="dist"
STAGE="$DIST/stage-$STAMP"
PKG="$DIST/kb-deskpet-migrate-${STAMP}.tgz"

mkdir -p "$STAGE"
chmod 700 "$STAGE"

echo "1/4 收集代码（含 git 历史）"
tar -czf "$STAGE/code.tgz" \
  --exclude=.venv \
  --exclude=dist \
  --exclude=server/data \
  --exclude=.env \
  --exclude=.DS_Store \
  --exclude='*.pyc' \
  --exclude=__pycache__ \
  -C "$REPO" .

echo "2/4 复制环境变量"
if [[ -f .env ]]; then
  cp .env "$STAGE/env.production"
  chmod 600 "$STAGE/env.production"
  echo "   已包含 .env（含 key，传输请走 scp，别发微信）"
else
  cp .env.example "$STAGE/env.example"
  echo "   未找到 .env，只放了 .env.example —— 目标机要自己填 key"
fi

echo "3/4 导出数据库（有真实数据才需要）"
if docker compose exec -T postgres pg_isready -U kb -d kb >/dev/null 2>&1; then
  ROWS=$(docker compose exec -T postgres psql -U kb -d kb -Atc "select count(*) from documents" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [[ "${ROWS:-0}" -gt 0 ]]; then
    docker compose exec -T postgres pg_dump -U kb -d kb -Fc > "$STAGE/kb.dump"
    echo "   已导出 kb.dump（当前 ${ROWS} 篇文档）"
  else
    echo "   库里没有文档，跳过 dump（目标机跑迁移即可）"
  fi
else
  echo "   postgres 未运行，跳过 dump"
fi

echo "4/4 打包"
tar -czf "$PKG" -C "$STAGE" .
( cd "$DIST" && shasum -a 256 "$(basename "$PKG")" > "$(basename "$PKG").sha256" )

SIZE=$(du -h "$PKG" | cut -f1)
echo
echo "完成：$REPO/$PKG  ($SIZE)"
echo "校验：$REPO/${PKG}.sha256"
echo "下一步："
echo "  scp $PKG <用户>@<虚拟机IP>:~/"
echo "  在虚拟机上： bash deploy/bootstrap.sh $(basename "$PKG")"
