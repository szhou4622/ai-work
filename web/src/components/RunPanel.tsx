import { NODE_LABEL, RUN_STATUS, ROLE_LABEL, NODE_ROLE, ROLE_COLOR } from '../zh';
import { useNow, fmtDuration } from '../hooks/useNow';

/** 单个 Agent 运行的详细面板：状态、耗时、输出统计、文件变更、实时日志 */
export default function RunPanel({
  run,
  logText,
  handoffs,
  expanded,
  onToggle,
  logRef,
}: {
  run: any;
  logText: string;
  handoffs?: any[];
  expanded: boolean;
  onToggle: () => void;
  logRef?: (el: HTMLDivElement | null) => void;
}) {
  const now = useNow(1000);
  const isRunning = run.status === 'RUNNING';

  const h = (handoffs ?? []).find((x: any) => x.agent_run_id === run.id);
  let files: string[] = [];
  if (h?.files_changed) {
    try {
      const arr = typeof h.files_changed === 'string' ? JSON.parse(h.files_changed) : h.files_changed;
      files = Array.isArray(arr) ? arr.map(String) : [];
    } catch { /* 忽略 */ }
  }

  const duration = isRunning
    ? fmtDuration(run.started_at ? now - run.started_at : 0)
    : fmtDuration(run.started_at && run.ended_at ? run.ended_at - run.started_at : 0);
  const lineCount = logText ? logText.split('\n').filter((l) => l.trim()).length : 0;
  const roleKey = NODE_ROLE[run.node_id] ?? run.node_id;
  const roleColor = ROLE_COLOR[roleKey] ?? 'var(--text-3)';

  return (
    <div id={`run-${run.id}`} className={`run-panel ${isRunning ? 'run-active' : ''}`}>
      <div className="run-header">
        <span className="tag tag-info">{NODE_LABEL[run.node_id] ?? run.node_id}</span>
        <strong>{run.agent_name ?? ROLE_LABEL[roleKey] ?? '—'}</strong>
        <span style={{ color: roleColor, fontSize: 12, fontWeight: 600 }}>{ROLE_LABEL[roleKey] ?? roleKey}</span>
        <span className={`tag ${run.status === 'COMPLETED' ? 'tag-ok' : run.status === 'FAILED' ? 'tag-err' : ''}`}>
          {RUN_STATUS[run.status] ?? run.status}
        </span>
        {isRunning && <span className="run-live">● LIVE</span>}
        <span className="run-stat">⏱ {duration}{isRunning ? '（进行中）' : ''}</span>
        {lineCount > 0 && <span className="run-stat">📄 {lineCount} 行输出</span>}
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {run.started_at ? new Date(run.started_at).toLocaleTimeString('zh-CN') : '—'}
          {run.ended_at ? ` → ${new Date(run.ended_at).toLocaleTimeString('zh-CN')}` : ''}
        </span>
        <button className="btn btn-mini" style={{ marginLeft: 'auto' }} onClick={onToggle}>
          {expanded ? '收起日志' : '展开日志'}
        </button>
      </div>

      {files.length > 0 && (
        <div className="run-files">
          文件变更：
          {files.map((f: string) => (
            <span key={f} className="file-chip">{f}</span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="log-view run-log" ref={logRef}>
          {logText || <span style={{ color: 'var(--text-3)' }}>（暂无输出，等待智能体开始…）</span>}
        </div>
      )}
    </div>
  );
}
