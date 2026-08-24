#!/bin/bash

TASK_ID="1c15d470-79b3-43d7-9a09-3ebe6331721c"
LOG_FILE="/Users/shiqi/Documents/deepseek harness/ai工作台/task_monitor.log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
echo "开始监控任务: $TASK_ID" | tee -a "$LOG_FILE"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

LAST_STATE=""
COUNT=0

while true; do
  COUNT=$((COUNT + 1))
  
  RESULT=$(curl -s "http://118.196.92.95:8620/api/tasks/$TASK_ID/detail" 2>/dev/null)
  
  if [ -z "$RESULT" ]; then
    echo "[$(date '+%H:%M:%S')] API 请求失败，等待重试..." | tee -a "$LOG_FILE"
    sleep 15
    continue
  fi
  
  TASK_STATUS=$(echo "$RESULT" | jq -r '.task.status')
  AGENT=$(echo "$RESULT" | jq -r '.runs[-1].agent_name')
  RUN_STATUS=$(echo "$RESULT" | jq -r '.runs[-1].status')
  RUNS_COUNT=$(echo "$RESULT" | jq '.runs | length')
  
  STATE="$TASK_STATUS:$AGENT:$RUN_STATUS"
  
  if [ "$STATE" != "$LAST_STATE" ]; then
    echo "[$(date '+%H:%M:%S')] #$COUNT | 任务=$TASK_STATUS | $AGENT ($RUN_STATUS) | 总运行=$RUNS_COUNT" | tee -a "$LOG_FILE"
    LAST_STATE="$STATE"
    
    # 检查是否完成
    if [[ "$TASK_STATUS" == "COMPLETED" ]]; then
      echo "" | tee -a "$LOG_FILE"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
      echo "🎉 任务完成！" | tee -a "$LOG_FILE"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
      echo "" | tee -a "$LOG_FILE"
      curl -s "http://118.196.92.95:8620/api/tasks/$TASK_ID/detail" | jq '{
        task_status: .task.status,
        total_runs: (.runs | length),
        completed_at: (.task.completed_at / 1000 | strftime("%Y-%m-%d %H:%M:%S"))
      }' | tee -a "$LOG_FILE"
      exit 0
    fi
    
    # 检查是否需要人工处理
    if [[ "$TASK_STATUS" == "NEEDS_HUMAN" ]] || [[ "$TASK_STATUS" == "FAILED" ]]; then
      echo "" | tee -a "$LOG_FILE"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
      echo "⚠️  任务状态: $TASK_STATUS" | tee -a "$LOG_FILE"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
      exit 1
    fi
  fi
  
  sleep 30
done
