import { useEffect, useState } from 'react';
import { get, post, put, del } from '../api';
import { ROLE_LABEL } from '../zh';

interface Agent {
  id: string;
  name: string;
  role_id: string;
  runtime_id: string;
  model_id: string;
  provider_id: string;
  provider_key_id?: string;
  billing_route_id: string;
}

interface Role { id: string; name: string; }
interface 运行方式 { id: string; name: string; type: string; }
interface Provider { id: string; name: string; model_mapping: Record<string, string>; }
interface ProviderKey { id: string; name: string; model_mapping: Record<string, string>; }

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [runtimes, set运行方式s] = useState<运行方式[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<Record<string, ProviderKey[]>>({});
  const [form, setForm] = useState({ name: '', role_id: '', runtime_id: '', model_id: '', provider_id: '', provider_key_id: '', billing_route_id: 'br-relay', prompt_override: '' });
  const [editing, setEditing] = useState<Agent | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => Promise.all([
    get<Agent[]>('/api/agents').then(setAgents),
    get<Role[]>('/api/roles').then(setRoles),
    get<运行方式[]>('/api/runtimes').then(set运行方式s),
    get<Provider[]>('/api/providers').then(setProviders),
  ]).catch((e) => setMsg(e.message));

  useEffect(() => { load(); }, []);

  const loadKeys = async (providerId: string) => {
    if (!providerId) return;
    try {
      const ks = await get<ProviderKey[]>(`/api/providers/${providerId}/keys`);
      setKeys((k) => ({ ...k, [providerId]: ks }));
    } catch { /* ignore */ }
  };

  const onProviderChange = (providerId: string) => {
    setForm({ ...form, provider_id: providerId, provider_key_id: '', model_id: '' });
    loadKeys(providerId);
  };

  const selectedProvider = providers.find((p) => p.id === form.provider_id);
  const providerKeys = keys[form.provider_id] ?? [];
  const selectedKey = providerKeys.find((k) => k.id === form.provider_key_id);
  // 模型选项：优先所选密钥的映射，其次 Provider 默认映射
  const modelOptions = Object.keys(selectedKey?.model_mapping ?? selectedProvider?.model_mapping ?? {});

  const submit = async () => {
    setMsg('');
    if (!form.name || !form.role_id || !form.runtime_id || !form.provider_id) {
      setMsg('请填写名称并选择角色 / 运行方式 / Provider');
      return;
    }
    const model = form.model_id || modelSearch.trim();
    if (!model) { setMsg('请选择或输入模型'); return; }
    try {
      const body: any = { ...form, model_id: model, provider_key_id: form.provider_key_id || null, prompt_override: form.prompt_override || null };
      if (editing) {
        await put(`/api/agents/${editing.id}`, body);
        setMsg('已更新');
      } else {
        await post('/api/agents', body);
      }
      setForm({ ...form, name: '', model_id: '', provider_key_id: '', prompt_override: '' });
      setEditing(null);
      setModelSearch('');
      load();
    } catch (e: any) { setMsg(e.message); }
  };

  const startEdit = (a: Agent) => {
    setEditing(a);
    setForm({ name: a.name, role_id: a.role_id, runtime_id: a.runtime_id, model_id: a.model_id, provider_id: a.provider_id, provider_key_id: a.provider_key_id ?? '', billing_route_id: a.billing_route_id, prompt_override: (a as any).prompt_override ?? '' });
    setModelSearch('');
    if (a.provider_id) loadKeys(a.provider_id);
  };
  const cancelEdit = () => { setEditing(null); setForm({ ...form, name: '', model_id: '', provider_key_id: '', prompt_override: '' }); };

  return (
    <div>
      <h2 className="page-title">智能体管理</h2>
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{editing ? `编辑智能体：${editing.name}` : '新建智能体'}</h3>
        <div className="form-row"><label>名称</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：执行者-DeepSeek" /></div>
        <div className="form-row">
          <label>角色</label>
          <select value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })}>
            <option value="">选择角色</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{ROLE_LABEL[r.id.replace('role-','')] ?? r.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>运行方式</label>
          <select value={form.runtime_id} onChange={(e) => setForm({ ...form, runtime_id: e.target.value })}>
            <option value="">选择 运行方式</option>
            {runtimes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>中转（Provider）</label>
          <select value={form.provider_id} onChange={(e) => onProviderChange(e.target.value)}>
            <option value="">选择中转</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {form.provider_id && providerKeys.length > 0 && (
          <div className="form-row">
            <label>密钥（该中转下有 {providerKeys.length} 个密钥，不同密钥模型不同）</label>
            <select value={form.provider_key_id} onChange={(e) => setForm({ ...form, provider_key_id: e.target.value, model_id: '' })}>
              <option value="">（中转默认密钥）</option>
              {providerKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
        )}
        <div className="form-row">
          <label>模型（输入关键词搜索，如 gpt / claude / opus；或直接输入完整模型名；共 {modelOptions.length} 个可选）</label>
          <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="搜索或直接输入模型名…" />
          {modelOptions.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
              {modelOptions
                .filter((m) => !modelSearch.trim() || m.toLowerCase().includes(modelSearch.trim().toLowerCase()))
                .map((m) => (
                  <button key={m} className={`btn ${form.model_id === m ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setForm({ ...form, model_id: m }); setModelSearch(''); }}>
                    <span className="mono">{m}</span>
                  </button>
                ))}
            </div>
          )}
          {form.model_id && <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>已选模型：<span className="mono">{form.model_id}</span></div>}
        </div>
        <div className="form-row">
          <label>自定义提示词（留空使用角色默认；可写：你是资深 XX 工程师，负责 XX…）</label>
          <textarea rows={4} value={form.prompt_override} onChange={(e) => setForm({ ...form, prompt_override: e.target.value })} placeholder="自定义该智能体的系统提示词…" />
        </div>
        <button className="btn btn-primary" onClick={submit}>{editing ? '保存修改' : '保存'}</button>{' '}
        {editing && <button className="btn btn-secondary" onClick={cancelEdit}>取消</button>}
        {msg && <div className="msg msg-err">{msg}</div>}
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>智能体列表</h3>
        <table>
          <thead><tr><th>名称</th><th>角色</th><th>运行方式</th><th>Provider</th><th>密钥</th><th>模型</th><th>操作</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{roles.find((r) => r.id === a.role_id)?.name ?? a.role_id}</td>
                <td>{runtimes.find((r) => r.id === a.runtime_id)?.name ?? a.runtime_id}</td>
                <td>{providers.find((p) => p.id === a.provider_id)?.name ?? a.provider_id}</td>
                <td>{providerKeys.find((k) => k.id === a.provider_key_id)?.name ?? '默认'}</td>
                <td className="mono">{a.model_id}{(a as any).prompt_override ? ' ✏️' : ''}</td>
                <td>
                  <button className="btn btn-secondary" onClick={() => startEdit(a)}>编辑</button>{' '}
                  <button className="btn btn-danger" onClick={() => {
                    if (window.confirm(`确认删除智能体「${a.name}」？`)) del(`/api/agents/${a.id}`).then(() => { setAgents((l) => l.filter((x) => x.id !== a.id)); load(); }).catch((e) => setMsg(e.message));
                  }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
