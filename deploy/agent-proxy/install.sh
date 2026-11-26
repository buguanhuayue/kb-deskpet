#!/usr/bin/env bash
# kb-agent 安装脚本：从 WeKnora 容器取模型密钥、写 env、装 systemd 单元
#
# 为什么要从容器取：Agnes 的 key 只在 WeKnora 的容器环境里，models 表里那份是
# 加密的（直接用会 401）。这里导出到本地 agent.env（600），不写进代码仓库。
set -euo pipefail

DIR="${HOME}/kb-agent"
UNIT=/etc/systemd/system/kb-agent.service

mkdir -p "$DIR"

if [ ! -f "$DIR/kb_agent.py" ]; then
  echo "缺少 kb_agent.py，先把 deploy/agent-proxy/kb_agent.py 传到 $DIR/" >&2
  exit 1
fi

if [ ! -f "$DIR/agent.env" ]; then
  KEY=$(docker exec WeKnora-app printenv LLM_API_KEY)
  if [ -z "$KEY" ]; then
    echo "取不到 LLM_API_KEY，检查容器名是否为 WeKnora-app" >&2
    exit 1
  fi
  cat > "$DIR/agent.env" <<EOF
AGNES_KEY=$KEY
AGNES_BASE=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-3.0-flash
WEKNORA_BASE=http://localhost:18080/api/v1
PORT=8091
MAX_ROUNDS=3
BUDGET_SEC=28
EOF
  chmod 600 "$DIR/agent.env"
  echo "已写入 $DIR/agent.env（600）"
fi

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=kb-agent 知识小助工具循环代理
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$DIR
EnvironmentFile=$DIR/agent.env
Environment=PYTHONIOENCODING=utf-8
ExecStart=/usr/bin/python3 $DIR/kb_agent.py
Restart=always
RestartSec=3
StandardOutput=append:$DIR/service.log
StandardError=append:$DIR/service.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now kb-agent.service
sleep 2

echo '--- 健康检查 ---'
curl -s -m 5 "http://localhost:8091/health" || echo '未响应，看 journalctl -u kb-agent -n 30'
echo
