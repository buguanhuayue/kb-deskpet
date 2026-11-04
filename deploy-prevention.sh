#!/bin/bash
# 在服务器上执行此脚本：bash deploy-prevention.sh

set -e

echo "=========================================="
echo "部署 embed 服务预防措施"
echo "=========================================="
echo ""

echo "=== 1. 添加定时重启任务 ==="
# 先删除可能存在的旧任务，再添加新任务
(crontab -l 2>/dev/null | grep -v "kb-embed.*restart" || true; echo "0 3 * * * cd ~/kb-embed && docker compose restart embed >> ~/embed-restart.log 2>&1") | crontab -
echo "✅ cron 任务已添加：每天凌晨 3 点重启 embed 服务"

echo ""
echo "=== 2. 部署内存监控脚本 ==="
cat > ~/monitor-embed.sh << 'SCRIPT'
#!/bin/bash
THRESHOLD=7.0

while true; do
  # 获取内存使用（GiB）
  MEM=$(docker stats kb-deskpet-embed-1 --no-stream --format "{{.MemUsage}}" | awk '{print $1}' | sed 's/GiB//')
  TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
  
  # 检查是否超过阈值
  if (( $(echo "$MEM > $THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
    echo "[$TIMESTAMP] ⚠️  embed 内存告警: ${MEM}GB / 8GB (阈值 ${THRESHOLD}GB)" | tee -a ~/embed-monitor.log
  fi
  
  sleep 300  # 每 5 分钟检查一次
done
SCRIPT

chmod +x ~/monitor-embed.sh
echo "✅ 监控脚本已创建：~/monitor-embed.sh"

echo ""
echo "=== 3. 启动监控进程 ==="
# 先停止旧的监控进程
OLD_PID=$(pgrep -f "monitor-embed.sh" || true)
if [ -n "$OLD_PID" ]; then
  echo "停止旧的监控进程 PID: $OLD_PID"
  kill $OLD_PID 2>/dev/null || true
  sleep 2
fi

# 启动新的监控进程
nohup ~/monitor-embed.sh > /dev/null 2>&1 &
NEW_PID=$!
echo "✅ 监控进程已启动，PID: $NEW_PID"

echo ""
echo "=== 4. 验证部署 ==="
echo ""
echo "--- Cron 任务 ---"
crontab -l | grep embed || echo "未找到 cron 任务"

echo ""
echo "--- 监控进程 ---"
ps aux | grep monitor-embed | grep -v grep || echo "监控进程未运行"

echo ""
echo "--- 当前 embed 内存使用 ---"
docker stats kb-deskpet-embed-1 --no-stream --format "table {{.Container}}\t{{.MemUsage}}\t{{.MemPerc}}"

echo ""
echo "=========================================="
echo "✅ 部署完成！"
echo "=========================================="
echo ""
echo "📊 监控日志位置：~/embed-monitor.log"
echo "📊 重启日志位置：~/embed-restart.log"
echo ""
echo "💡 查看监控日志：tail -f ~/embed-monitor.log"
echo "💡 查看重启日志：tail -f ~/embed-restart.log"
echo "💡 停止监控：pkill -f monitor-embed.sh"
echo ""
