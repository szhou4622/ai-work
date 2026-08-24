import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

interface Task { id: string; title: string; objective: string; project_id: string; status: string; created_at: number; }
interface Project { id: string; name: string; }
interface Workflow { id: string; name: string; }
interface Preset { id: string; name: string; description: string; role_agent_map: Record<string, string>; }
interface Agent { id: string; name: string; role_id: string; }

const ROLE_KEYS = ['architect', 'lead', 'reviewer', 'qa'] as const;
const ROLE_LABEL: Record<string, string> = { architect: '架构师', lead: '主调度', implementer: '执行者', reviewer: '审查', qa: '质检' };

const STATUS: Record<string, { label: string; cls: string; progress: number }> = {
  CREATED: { label: '已创建', cls: 'tag', progress: 5 },
  QUEUED: { label: '排队中', cls: 'tag', progress: 5 },
  WAITING_CLARIFICATION: { label: '等你澄清', cls: 'tag-warn', progress: 8 },
  ARCHITECTURE: { label: '架构设计中', cls: 'tag-info', progress: 18 },
  WAITING_DEVDOC_CONFIRM: { label: '等你确认文档', cls: 'tag-warn', progress: 25 },
  PLANNING: { label: '任务拆解中', cls: 'tag-info', progress: 35 },
  EXECUTING: { label: '执行中', cls: 'tag-info', progress: 55 },
  REVIEWING: { label: '审查中', cls: 'tag-info', progress: 70 },
  FIXING: { label: '返工中', cls: 'tag-warn', progress: 60 },
  INTEGRATING: { label: '整合中', cls: 'tag-info', progress: 80 },
  TESTING: { label: '质检中', cls: 'tag-info', progress: 88 },
  WAITING_ACCEPTANCE: { label: '等你验收', cls: 'tag-warn', progress: 94 },
  WAITING_APPROVAL: { label: '等你审批', cls: 'tag-warn', progress: 60 },
  NEEDS_HUMAN: { label: '需要人工介入', cls: 'tag-err', progress: 60 },
  COMPLETED: { label: '已完成', cls: 'tag-ok', progress: 100 },
  FAILED: { label: '失败', cls: 'tag-err', progress: 100 },
  CANCELLED: { label: '已取消', cls: 'tag', progress: 100 },
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [form, setForm] = useState({ title: '', objective: '', project_id: '', workflow_id: 'wf-standard', preset_id: '', auto_mode: false });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const load = () => Promise.all([
    get<Task[]>('/api/tasks').then(setTasks),
    get<Project[]>('/api/projects').then(setProjects),
    get<Workflow[]>('/api/workflows').then(setWorkflows),
    get<Preset[]>('/api/presets').then(setPresets),
    get<Agent[]>('/api/agents').then(setAgents),
    get<any>('/api/usage/summary').then(setUsage).catch(() => {}),
  ]).catch((e) => setMsg(e.message));

  useEffect(() => {
    load();
    // 实时刷新：3 秒轮询（页面不可见时暂停，节省请求）
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const onPresetChange = (presetId: string) => {
    setForm({ ...form, preset_id: presetId });
    const preset = presets.find((p) => p.id === presetId);
    if (preset) setOverrides({ ...preset.role_agent_map });
    else setOverrides({});
  };

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? '（未配置）';

  const create = async () => {
    setMsg('');
    if (!form.title || !form.objective || !form.project_id) { setMsg('请填写标题、目标并选择项目'); return; }
    try {
      const body: any = { ...form, workflow_id: form.workflow_id || 'wf-standard' };
      if (Object.keys(overrides).length > 0) body.agent_overrides = overrides;
      body.auto_mode = form.auto_mode ? 1 : 0;
      const t = await post<Task>('/api/tasks', body);
      setForm({ ...form, title: '', objective: '' });
      load();
      window.location.href = `/tasks/${t.id}`;
    } catch (e: any) { setMsg(e.message); }
  };

  const running = tasks.filter((t) => ['EXECUTING', 'ARCHITECTURE', 'PLANNING', 'REVIEWING', 'TESTING', 'FIXING', 'INTEGRATING', 'WAITING_CLARIFICATION', 'WAITING_DEVDOC_CONFIRM', 'WAITING_ACCEPTANCE', 'WAITING_APPROVAL', 'NEEDS_HUMAN', 'QUEUED'].includes(t.status));
  const waitingYou = tasks.filter((t) => ['WAITING_CLARIFICATION', 'WAITING_DEVDOC_CONFIRM', 'WAITING_ACCEPTANCE', 'WAITING_APPROVAL', 'NEEDS_HUMAN'].includes(t.status));
  const done = tasks.filter((t) => t.status === 'COMPLETED').length;

  return (
    <div>
      <h2 className="page-title">开发工作台</h2>
      {msg && <div className="msg msg-err">{msg}</div>}

      <div className="stat-grid">
        <div className="stat-card glow">
          <div className="stat-label">进行中 / 待处理</div>
          <div className="stat-value">{running.length}</div>
          <div className="stat-sub">共 {tasks.length} 个任务</div>
        </div>
        <div className="stat-card glow">
          <div className="stat-label">需要你操作</div>
          <div className="stat-value">{waitingYou.length}</div>
          <div className="stat-sub">澄清 / 确认文档 / 验收 / 审批</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">已完成交付</div>
          <div className="stat-value">{done}</div>
          <div className="stat-sub">任务</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">用量 / 费用（估算）</div>
          <div className="stat-value">${(usage?.cost_est ?? 0).toFixed(4)}</div>
          <div className="stat-sub">{((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)).toLocaleString()} tokens</div>
        </div>
      </div>

      <div className="card">
        <h3>发布新任务</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="form-row"><label>任务标题</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：给项目新增登录功能" /></div>
          <div className="form-row"><label>项目</label>
            <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
              <option value="">选择项目</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row"><label>一句话需求</label><textarea rows={2} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} placeholder="描述你想要实现的目标…" /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="form-row">
            <label>工作流</label>
            <select value={form.workflow_id} onChange={(e) => setForm({ ...form, workflow_id: e.target.value })}>
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>预设方案（角色→智能体搭配）</label>
            <select value={form.preset_id} onChange={(e) => onPresetChange(e.target.value)}>
              <option value="">（默认角色智能体）</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <button className="btn btn-secondary" style={{ marginBottom: 10 }} onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? '收起高级选项' : '高级选项（切换主调度等线路）'}
        </button>
        {showAdvanced && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 14, background: 'var(--surface-2)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
              每个角色可临时更换智能体（例如主调度切换：Codex 订阅 ⇄ API 中转），不影响预设本身。
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {ROLE_KEYS.map((role) => {
                const cands = agents.filter((a) => a.role_id === `role-${role}`);
                return (
                  <div key={role} className="form-row" style={{ marginBottom: 4 }}>
                    <label>{ROLE_LABEL[role]}：{agentName(overrides[role])}</label>
                    <select value={overrides[role] ?? ''} onChange={(e) => setOverrides({ ...overrides, [role]: e.target.value })}>
                      <option value="">（未指定）</option>
                      {cands.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, cursor: 'pointer', fontSize: 13.5 }}>
            <input type="checkbox" checked={form.auto_mode} onChange={(e) => setForm({ ...form, auto_mode: e.target.checked })} />
            全自动模式（跳过文档确认与最终验收，任务一键跑完；不勾选则到关键节点会等你确认）
          </label>
        </div>
        <button className="btn btn-primary" onClick={create}>创建并进入任务</button>
      </div>

      <div className="task-grid">
        {tasks.map((t) => {
          const st = STATUS[t.status] ?? { label: t.status, cls: 'tag', progress: 50 };
          const waiting = ['WAITING_CLARIFICATION', 'WAITING_DEVDOC_CONFIRM', 'WAITING_ACCEPTANCE', 'WAITING_APPROVAL', 'NEEDS_HUMAN'].includes(t.status);
          return (
            <Link key={t.id} to={`/tasks/${t.id}`} className="task-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div className="task-title" style={{ flex: 1 }}>
                  {t.title}
                  {waiting && <span className="red-dot" title="需要你操作" />}
                </div>
                <span className={`tag ${st.cls}`}>{st.label}</span>
              </div>
              <div className="task-meta">
                {projects.find((p) => p.id === t.project_id)?.name ?? '—'} · {new Date(t.created_at).toLocaleString('zh-CN')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.objective}
              </div>
              <div className="progress"><div style={{ width: `${st.progress}%` }} /></div>
            </Link>
          );
        })}
        {tasks.length === 0 && (
          <div className="card" style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-3)' }}>
            还没有任务。发布第一个任务，AI 开发团队开始为你工作 →
          </div>
        )}
      </div>
    </div>
  );
}
