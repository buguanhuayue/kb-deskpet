#!/usr/bin/env bash
# 在目标虚拟机（Ubuntu 22.04/24.04）执行：装环境、解包、起服务、自检。
#
#   bash bootstrap.sh kb-deskpet-migrate-20261030-1700.tgz
#
# 幂等：重复执行会更新代码并重建容器，不会重复建库（数据在 docker volume 里）。
set -euo pipefail

PKG="${1:-}"
WORK="${WORK:-$HOME/kb-deskpet}"

if [[ -z "$PKG" || ! -f "$PKG" ]]; then
  echo "用法: bash bootstrap.sh <迁移包.tgz>" >&2
  exit 1
fi

echo "== 1/6 检查并安装 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  echo "   Docker 已安装；若当前会话无权限，重新登录后再跑一次。"
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "缺少 docker compose 插件，请先安装 docker-compose-plugin" >&2
  exit 1
fi

echo "== 2/6 解包 =="
TMP="$(mktemp -d)"
tar -xzf "$PKG" -C "$TMP"
mkdir -p "$TMP/repo"
tar -xzf "$TMP/code.tgz" -C "$TMP/repo"

if [[ -d "$WORK/.git" ]]; then
  echo "   目标已存在仓库，覆盖更新（.env 与数据盘不受影响）"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude=.env --exclude='server/data' "$TMP/repo/" "$WORK/"
  else
    tar -xzf "$TMP/code.tgz" -C "$WORK"
  fi
else
  mv "$TMP/repo" "$WORK"
fi
cd "$WORK"
# 清掉 macOS 打包带来的 AppleDouble 影子文件
find "$WORK" -name "._*" -type f -delete 2>/dev/null || true

echo "== 3/6 写入 .env =="
if [[ -f "$TMP/env.production" ]]; then
  [[ -f .env ]] && cp .env ".env.bak.$(date +%s)"
  cp "$TMP/env.production" .env
  chmod 600 .env
elif [[ ! -f .env ]]; then
  cp .env.example .env
  echo "   !! 需要手工填 key：nano .env"
fi

echo "== 4/6 起服务 =="
docker compose up -d --build
echo "   等待 postgres 就绪"
for _ in $(seq 1 40); do
  docker compose exec -T postgres pg_isready -U kb -d kb >/dev/null 2>&1 </dev/null && break
  sleep 2
done

echo "== 5/6 恢复数据 / 迁移 =="
if [[ -f "$TMP/kb.dump" ]]; then
  docker compose exec -T postgres pg_restore -U kb -d kb --clean --if-exists < "$TMP/kb.dump" || true
  echo "   已从 kb.dump 恢复"
else
  if ! docker compose exec -T api python scripts/migrate.py </dev/null; then
    echo "-- 迁移失败，api 日志如下 --" >&2
    docker compose logs api --tail 40 >&2 || true
    exit 1
  fi
fi

echo "== 6/6 自检 =="
docker compose exec -T api python scripts/check_keys.py </dev/null || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "完成。验收台： http://${IP:-localhost}:8088"
echo "对外访问前请放行 8088，或套 Nginx + HTTPS。"
echo "首个账号： docker compose exec api python scripts/seed.py"
rm -rf "$TMP"
