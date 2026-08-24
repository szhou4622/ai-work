import { useState } from 'react';
import { RUN_STATUS, ROLE_LABEL, NODE_ROLE, ROLE_COLOR } from '../zh';
import { useNow, fmtDuration } from '../hooks/useNow';

/**
 * 执行画板：以看板形式实时展示任务执行状态。
 * - 每个工作流阶段一列（澄清/文档/拆解/执行/审查/整合/质检/验收）
 * - 每个 Agent 运行是一张卡片，随状态着色；运行中的卡片 LIVE 闪烁
 * - 分工一眼可见：卡片按角色配色（架构师紫/主调度蓝/执行者绿/审查橙/质检青）
 * - 卡片实时展示运行时长与微型进度条；完成时展示文件变更
 * - 顶部统计条：本任务共调度几次 Agent 运行、执行中/完成/失败数量
 * - 列状态由状态机转换推导：绿=已完成、蓝=进行中、红=失败/需人工、灰=等待
 */
export interface BoardRun {
  id: string;
  node_id: string;
  agent_name?: string;
  status: string;
  started_at?: number;
  ended_at?: number;
}

interface TaskBoardProps {
  task: any;
  transitions: any[];
  runs: BoardRun[];
  subtasks: any[];
  handoffs?: any[];
  logs: Record<string, string>;
  onShowRun: (runId: string) => void;
}

/** 列顺序 = 标准工作流；key 对应引擎 node_id，status 对应任务状态机 */
const COLUMNS: { key: string; label: string; status: string }[] = [
  { key: 'clarify', label: '需求澄清', status: 'ARCHITECTURE' },
  { key: 'devdoc_confirm', label: '文档确认', status: 'WAITING_DEVDOC_CONFIRM' },
  { key: 'plan', label: '任务拆解', status: 'PLANNING' },
  { key: 'execute', label: '执行', status: 'EXECUTING' },
  { key: 'review', label: '审查', status: 'REVIEWING' },
  { key: 'integrate', label: '整合', status: 'INTEGRATING' },
  { key: 'qa', label: '质检', status: 'TESTING' },
  { key: 'acceptance', label: '验收', status: 'WAITING_ACCEPTANCE' },
];

const STATUS_LABEL: Record<string, string> = {
  CREATED: '已创建', QUEUED: '排队中', WAITING_CLARIFICATION: '等你澄清',
  ARCHITECTURE: '架构设计', WAITING_DEVDOC_CONFIRM: '等你确认文档',
  PLANNING: '任务拆解', EXECUTING: '执行中', REVIEWING: '审查中', FIXING: '返工中',
  INTEGRATING: '整合中', TESTING: '测试中', WAITING_ACCEPTANCE: '等你验收',
  WAITING_APPROVAL: '等你审批', NEEDS_HUMAN: '需要人工介入',
  COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消',
};

/** 解析 handoffs.files_changed（JSON 字符串）为文件名数组 */
function filesOf(handoffs: any[] | undefined, runId: string): string[] {
  const h = (handoffs ?? []).find((x: any) => x.agent_run_id === runId);
  if (!h?.files_changed) return [];
  try {
    const arr = typeof h.files_changed === 'string' ? JSON.parse(h.files_changed) : h.files_changed;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export default function TaskBoard({ task, transitions, runs, subtasks, handoffs, logs, onShowRun }: TaskBoardProps) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = useNow(1000);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doneStatuses = new Set((transitions ?? []).map((t: any) => t.to_status));
  const colState = (status: string): string => {
    // 当前状态优先：即使该阶段曾到达过，只要任务正停在这里就是"进行中/失败"
    if (task.status === status) {
      return ['FAILED', 'NEEDS_HUMAN'].includes(task.status) ? 'failed' : 'active';
    }
    if (doneStatuses.has(status)) return 'done';
    return 'pending';
  };

  const running = (runs ?? []).filter((r) => r.status === 'RUNNING').length;
  const completed = (runs ?? []).filter((r) => r.status === 'COMPLETED').length;
  const failed = (runs ?? []).filter((r) => r.status === 'FAILED').length;
  const flow = (transitions ?? []).map((t: any) => STATUS_LABEL[t.to_status] ?? t.to_status).join(' → ');

  const statusCls = (s: string) => s.toLowerCase().replace('_', '-');

  return (
    <div className="card">
      <div className="board-head">
        <h3 style={{ marginBottom: 0 }}>🎨 执行画板</h3>
        <div className="board-stats">
          <span className="stat-total">🤖 调度 {(runs ?? []).length} 次</span>
          <span className="stat-running">● 执行中 {running}</span>
          <span className="stat-ok">✓ 完成 {completed}</span>
          <span className="stat-err">✗ 失败 {failed}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
        阶段流转：{flow || '尚未开始调度'}
        {task.status === 'NEEDS_HUMAN' && <span style={{ color: 'var(--danger)' }}>（已暂停，需要人工介入）</span>}
      </div>

      <div className="task-board">
        {COLUMNS.map((col) => {
          const state = colState(col.status);
          const colRuns = (runs ?? []).filter((r) => r.node_id === col.key);
          const runningInCol = colRuns.filter((r) => r.status === 'RUNNING').length;
          const roleKey = NODE_ROLE[col.key] ?? col.key;
          const roleColor = ROLE_COLOR[roleKey] ?? 'var(--text-3)';
          return (
            <div key={col.key} className={`board-col ${state}`}>
              <div className="board-col-head" style={{ borderTop: `2px solid ${state === 'active' ? roleColor : 'transparent'}` }}>
                <span className="board-col-label">{col.label}</span>
                {state === 'active' && <span className="board-col-tag active">● 进行中</span>}
                {state === 'done' && <span className="board-col-tag done">✓</span>}
                {state === 'failed' && <span className="board-col-tag failed">✗</span>}
              </div>
              <div className="board-col-body">
                {colRuns.map((r) => {
                  const isRunning = r.status === 'RUNNING';
                  const isOpen = open.has(r.id);
                  const preview = logs[r.id] ?? '';
                  const duration = isRunning
                    ? fmtDuration((r.started_at ? now - r.started_at : 0))
                    : fmtDuration(r.started_at && r.ended_at ? r.ended_at - r.started_at : 0);
                  const files = filesOf(handoffs, r.id);
                  return (
                    <div
                      key={r.id}
                      className={`agent-card ${statusCls(r.status)} ${isRunning ? 'live' : ''}`}
                      style={{ borderLeft: `3px solid ${roleColor}` }}
                      onClick={() => toggle(r.id)}
                      title={isOpen ? '收起日志' : '点击展开日志'}
                    >
                      <div className="agent-card-top">
                        <span className={`agent-dot ${statusCls(r.status)}`} />
                        <strong className="agent-card-name">{r.agent_name ?? col.label}</strong>
                        <span className={`tag ${r.status === 'COMPLETED' ? 'tag-ok' : r.status === 'FAILED' ? 'tag-err' : ''}`}>
                          {RUN_STATUS[r.status] ?? r.status}
                        </span>
                      </div>
                      <div className="agent-card-meta">
                        <span style={{ color: roleColor, fontWeight: 600 }}>{ROLE_LABEL[roleKey] ?? roleKey}</span>
                        {' · '}耗时 {duration}
                      </div>
                      {/* 微型进度条：进行中 = 流动动画，完成 = 满格，失败 = 红色 */}
                      <div className="agent-progress">
                        <div className={isRunning ? 'bar-running' : r.status === 'COMPLETED' ? 'bar-done' : r.status === 'FAILED' ? 'bar-fail' : 'bar-wait'} />
                      </div>
                      {isRunning && <div className="agent-card-live">● 正在执行</div>}
                      {files.length > 0 && (
                        <div className="agent-card-files">
                          {files.slice(0, 3).map((f: string) => (
                            <span key={f} className="file-chip">{f.split('/').pop()}</span>
                          ))}
                          {files.length > 3 && <span className="file-chip">+{files.length - 3}</span>}
                        </div>
                      )}
                      {isOpen && (
                        <div className="agent-card-log">
                          {preview ? preview.slice(-600) : '（暂无输出，等待 Agent 开始…）'}
                        </div>
                      )}
                      <div className="agent-card-foot">
                        <span>{isRunning ? '实时更新中' : isOpen ? '收起日志' : '点击卡片看日志'}</span>
                        <button
                          className="btn btn-mini"
                          onClick={(e) => { e.stopPropagation(); onShowRun(r.id); }}
                          title="滚动到下方该次运行的详细日志面板"
                        >
                          详细面板 ↓
                        </button>
                      </div>
                    </div>
                  );
                })}
                {colRuns.length === 0 && (
                  <div className="board-empty">{state === 'pending' ? '等待调度' : state === 'done' ? '本阶段已通过' : state === 'failed' ? '已中断' : '—'}</div>
                )}
              </div>
              <div className="board-col-foot">
                {colRuns.length > 0 ? `${colRuns.length} 个 Agent${runningInCol > 0 ? ` · ${runningInCol} 并行` : ''}` : '0 个 Agent'}
              </div>
            </div>
          );
        })}
      </div>

      {subtasks.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          计划拆解（执行列模块）：
          {subtasks.map((s: any) => (
            <span key={s.id} className="module-chip">{s.module}</span>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10 }}>
        提示：点击 Agent 卡片可展开/收起该次运行的实时日志；点击卡片底部的「详细面板」可定位到下方完整日志。
      </div>
    </div>
  );
}
