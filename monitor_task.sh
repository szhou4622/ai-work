#!/bin/bash

# 监控脚本 - 持续跟踪任务状态
TASK_ID="1c15d470-79b3-43d7-9a09-3ebe6331721c"
API_URL="http://118.196.92.95:8620"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "AI工作台任务监控"
echo "任务 ID: $TASK_ID"
echo "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

LAST_STATUS=""

while true; do
  RESULT=$(curl -s "$API_URL/api/tasks/$TASK_ID/detail")
  
  TASK_STATUS=$(echo "$RESULT" | jq -r '.task.status')
  AGENT_NAME=$(echo "$RESULT" | jq -r '.runs[-1].agent_name')
  RUN_STATUS=$(echo "$RESULT" | jq -r '.runs[-1].status')
  
  CURRENT_STATE="$TASK_STATUS:$AGENT_NAME:$RUN_STATUS"
  
  # 状态改变时打印
  if [ "$CURRENT_STATE" != "$LAST_STATUS" ]; then
    echo "[$(date '+%H:%M:%S')] 任务=$TASK_STATUS | Agent=$AGENT_NAME ($RUN_STATUS)"
    LAST_STATUS="$CURRENT_STATE"
  fi
  
  # 终止条件
  if [[ "$TASK_STATUS" == "COMPLETED" ]]; then
    echo ""
    echo "✅ 任务完成！"
    exit 0
  fi
  
  if [[ "$TASK_STATUS" == "NEEDS_HUMAN" ]]; then
    echo ""
    echo "⚠️  需要人工处理"
    echo ""
    echo "原因:"
    echo "$RESULT" | jq -r '.transitions[-1].reason'
    exit 1
  fi
  
  if [[ "$TASK_STATUS" == "FAILED" ]] || [[ "$TASK_STATUS" == "CANCELLED" ]]; then
    echo ""
    echo "❌ 任务失败: $TASK_STATUS"
    exit 1
  fi
  
  sleep 30
done
