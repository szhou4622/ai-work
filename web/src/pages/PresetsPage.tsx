import { useEffect, useState } from 'react';
import { get, post, del } from '../api';

interface Preset {
  id: string;
  name: string;
  description: string;
  role_agent_map: Record<string, string>;
}
interface Agent { id: string; name: string; role_id: string; }

const ROLES = [
  { key: 'architect', label: '架构师' },
  { key: 'lead', label: '主调度' },
  { key: 'implementer', label: '执行者' },
  { key: 'reviewer_high', label: '审查（高质量）' },
  { key: 'reviewer_low', label: '审查（常规）' },
  { key: 'qa', label: '质检' },
];

export default function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ name: '', description: '' });
  const [map, setMap] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const load = () => Promise.all([
    get<Preset[]>('/api/presets').then(setPresets),
    get<Agent[]>('/api/agents').then(setAgents),
  ]).catch((e) => setMsg(e.message));

  useEffect(() => { load(); }, []);

  const candidatesFor = (roleKey: string) => {
    const roleId = roleKey.startsWith('reviewer') ? 'role-reviewer' : `role-${roleKey}`;
    return agents.filter((a) => a.role_id === roleId);
  };

  const submit = async () => {
    setMsg('');
    if (!form.name) { setMsg('请填写方案名称'); return; }
    const filled = ROLES.every((r) => map[r.key]);
    if (!filled) { setMsg('请为每个角色选择智能体'); return; }
    try {
      await post('/api/presets', { name: form.name, description: form.description, role_agent_map: map });
      setForm({ name: '', description: '' });
      setMap({});
      load();
      setMsg('预设方案已保存');
      setTimeout(() => setMsg(''), 2000);
    } catch (e: any) { setMsg('保存失败: ' + e.message); }
  };

  const agentName = (id?: string) => (id ? agents.find((a) => a.id === id)?.name ?? '未选' : '未选');

  return (
    <div>
      <h2 className="page-title">预设方案（整套角色→智能体搭配，发任务时一键选用）</h2>
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>新建预设方案</h3>
        <div className="form-row"><label>方案名称</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：默认方案 / 质量优先 / 省钱优先" /></div>
        <div className="form-row"><label>说明（可选）</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="如：架构=claude-fable-5 / 审查高=Pro / 审查低=Flash" /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {ROLES.map((r) => {
            const cands = candidatesFor(r.key);
            return (
              <div key={r.key} className="form-row" style={{ marginBottom: 4 }}>
                <label>{r.label}</label>
                <select value={map[r.key] ?? ''} onChange={(e) => setMap({ ...map, [r.key]: e.target.value })}>
                  <option value="">选择智能体</option>
                  {cands.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {cands.length === 0 && <div style={{ fontSize: 12, color: 'var(--danger)' }}>还没有该角色的智能体，请先到「智能体」页创建</div>}
              </div>
            );
          })}
        </div>
        <button className="btn btn-primary" onClick={submit}>保存方案</button>
        {msg && <div className="msg msg-ok">{msg}</div>}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>方案列表</h3>
        {presets.map((p) => (
          <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{p.name}</strong>
              {p.description && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.description}</span>}
              <span style={{ flex: 1 }} />
              <button className="btn btn-danger" onClick={() => { if (window.confirm(`确认删除方案「${p.name}」？`)) del(`/api/presets/${p.id}`).then(() => { setPresets((l) => l.filter((x) => x.id !== p.id)); load(); }).catch((e) => setMsg(e.message)); }}>删除</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {ROLES.map((r) => (
                <span key={r.key} style={{ fontSize: 12, background: 'var(--surface-2)', borderRadius: 6, padding: '3px 8px' }}>
                  {r.label}：<strong>{agentName(p.role_agent_map[r.key])}</strong>
                </span>
              ))}
            </div>
          </div>
        ))}
        {presets.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-3)' }}>暂无方案</div>}
      </div>
    </div>
  );
}
