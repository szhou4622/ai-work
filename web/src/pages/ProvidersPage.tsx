import { useEffect, useState } from 'react';
import { get, post, put, del } from '../api';
import { PROTOCOL_LABEL } from '../zh';

interface Provider {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  secret_ref: string;
  model_mapping: Record<string, string>;
  enabled: number;
}

interface ProviderKey {
  id: string;
  provider_id: string;
  name: string;
  model_mapping: Record<string, string>;
}

const EMPTY: Omit<Provider, 'id'> = {
  name: '', protocol: 'openai', base_url: '', secret_ref: '', model_mapping: {}, enabled: 1,
};

export default function ProvidersPage() {
  const [list, setList] = useState<Provider[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [apiKey, setApiKey] = useState('');
  const [editing, setEditing] = useState<Provider | null>(null);
  const [msg, setMsg] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any>>({});
  const [keys, setKeys] = useState<Record<string, ProviderKey[]>>({});
  const [keysOpen, setKeysOpen] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState<Record<string, { name: string; apiKey: string }>>({});
  const [keyModels, setKeyModels] = useState<Record<string, { models: string[]; checked: Record<string, boolean>; loading: boolean }>>({});
  const [editingKey, setEditingKey] = useState<Record<string, { name: string; apiKey: string }>>({});
  const [keyModelSearch, setKeyModelSearch] = useState<Record<string, string>>({});
  const [manualModel, setManualModel] = useState<Record<string, string>>({});

  const load = () => get<Provider[]>('/api/providers').then(setList).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const startEdit = (p: Provider) => {
    setEditing(p);
    setForm({ name: p.name, protocol: p.protocol, base_url: p.base_url, secret_ref: p.secret_ref, model_mapping: p.model_mapping, enabled: p.enabled });
    setApiKey('');
  };
  const cancelEdit = () => { setEditing(null); setForm(EMPTY); setApiKey(''); };

  const submit = async () => {
    setMsg('');
    try {
      const body = { ...form, apiKey: apiKey || undefined };
      if (editing) await put(`/api/providers/${editing.id}`, body);
      else await post('/api/providers', body);
      cancelEdit();
      load();
    } catch (e: any) { setMsg(e.message); }
  };

  const testConn = async (id: string) => {
    setTesting(id);
    setTestResult((r) => ({ ...r, [id]: undefined }));
    try {
      const res = await post(`/api/providers/${id}/test-connection`);
      setTestResult((r) => ({ ...r, [id]: res }));
    } catch (e: any) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, error: e.message } }));
    } finally {
      setTesting(null);
    }
  };

  /* ===== 密钥管理 ===== */

  const toggleKeys = async (providerId: string) => {
    const next = !keysOpen[providerId];
    setKeysOpen((k) => ({ ...k, [providerId]: next }));
    if (next) {
      try {
        const ks = await get<ProviderKey[]>(`/api/providers/${providerId}/keys`);
        setKeys((k) => ({ ...k, [providerId]: ks }));
      } catch { /* ignore */ }
    }
  };

  const addKey = async (providerId: string) => {
    const input = newKey[providerId] ?? { name: '', apiKey: '' };
    if (!input.name || !input.apiKey) { setMsg('密钥名称与 API Key 必填'); return; }
    try {
      await post(`/api/providers/${providerId}/keys`, input);
      setNewKey((k) => ({ ...k, [providerId]: { name: '', apiKey: '' } }));
      const ks = await get<ProviderKey[]>(`/api/providers/${providerId}/keys`);
      setKeys((k) => ({ ...k, [providerId]: ks }));
    } catch (e: any) { setMsg('新增密钥失败: ' + e.message); }
  };

  const loadKeyModels = async (keyId: string) => {
    setKeyModels((m) => ({ ...m, [keyId]: { models: [], checked: {}, loading: true } }));
    try {
      const key = Object.values(keys).flat().find((k) => k.id === keyId);
      const res = await get<{ models: string[]; model_mapping: Record<string, string> }>(`/api/providers/${key?.provider_id}/keys/${keyId}/models`);
      const checked: Record<string, boolean> = {};
      for (const k of Object.keys(res.model_mapping ?? {})) checked[k] = true;
      setKeyModels((m) => ({ ...m, [keyId]: { models: res.models ?? [], checked, loading: false } }));
    } catch (e: any) {
      setKeyModels((m) => ({ ...m, [keyId]: { models: [], checked: {}, loading: false } }));
      setMsg('拉取模型失败: ' + e.message);
    }
  };

  const toggleKeyModel = (keyId: string, model: string) => {
    setKeyModels((m) => {
      const cur = m[keyId];
      const checked = { ...cur.checked, [model]: !cur.checked[model] };
      persistKeyModels(keyId, checked);
      return { ...m, [keyId]: { ...cur, checked } };
    });
  };

  /** 即时重新保存该密钥的模型映射（勾选=新增，取消=删除） */
  const persistKeyModels = async (keyId: string, checked: Record<string, boolean>) => {
    const key = Object.values(keys).flat().find((k) => k.id === keyId);
    if (!key) return;
    const mapping: Record<string, string> = {};
    for (const [model, on] of Object.entries(checked)) if (on) mapping[model] = model;
    try {
      await put(`/api/providers/${key.provider_id}/keys/${keyId}`, { model_mapping: mapping });
      const ks = await get<ProviderKey[]>(`/api/providers/${key.provider_id}/keys`);
      setKeys((k) => ({ ...k, [key.provider_id]: ks }));
    } catch (e: any) {
      setMsg('保存模型失败: ' + e.message);
    }
  };

  const addManualModel = (keyId: string) => {
    const name = (manualModel[keyId] ?? '').trim();
    if (!name) return;
    setKeyModels((m) => {
      const cur = m[keyId] || { models: [], checked: {}, loading: false };
      const models = cur.models.includes(name) ? cur.models : [...cur.models, name];
      const checked = { ...cur.checked, [name]: true };
      persistKeyModels(keyId, checked);
      return { ...m, [keyId]: { ...cur, models, checked } };
    });
    setManualModel((s) => ({ ...s, [keyId]: '' }));
  };

  const saveKeyModels = async (keyId: string) => {
    const state = keyModels[keyId];
    if (!state) return;
    const mapping: Record<string, string> = {};
    for (const [model, on] of Object.entries(state.checked)) if (on) mapping[model] = model;
    const key = Object.values(keys).flat().find((k) => k.id === keyId);
    if (!key) return;
    try {
      await put(`/api/providers/${key.provider_id}/keys/${keyId}`, { model_mapping: mapping });
      setMsg('密钥模型已保存');
      const ks = await get<ProviderKey[]>(`/api/providers/${key.provider_id}/keys`);
      setKeys((k) => ({ ...k, [key.provider_id]: ks }));
    } catch (e: any) { setMsg('保存失败: ' + e.message); }
  };

  const deleteKey = async (keyId: string) => {
    const key = Object.values(keys).flat().find((k) => k.id === keyId);
    if (!key) return;
    if (!window.confirm('确认删除该密钥？')) return;
    try {
      await del(`/api/providers/${key.provider_id}/keys/${keyId}`);
      setKeys((k) => ({ ...k, [key.provider_id]: (k[key.provider_id] ?? []).filter((x) => x.id !== keyId) }));
      loadKeyModelsCleanup(keyId);
    } catch (e: any) { setMsg('删除失败: ' + e.message); }
  };

  /** 清理已删除密钥的模型勾选状态 */
  const loadKeyModelsCleanup = (keyId: string) => {
    setKeyModels((m) => {
      const n = { ...m };
      delete n[keyId];
      return n;
    });
  };

  const startEditKey = (keyId: string, name: string) => {
    setEditingKey((e) => ({ ...e, [keyId]: { name, apiKey: '' } }));
  };

  const saveEditKey = async (keyId: string) => {
    const key = Object.values(keys).flat().find((k) => k.id === keyId);
    if (!key) return;
    const edit = editingKey[keyId];
    if (!edit?.name) { setMsg('密钥名称不能为空'); return; }
    try {
      await put(`/api/providers/${key.provider_id}/keys/${keyId}`, { name: edit.name, apiKey: edit.apiKey || undefined });
      setEditingKey((e) => { const n = { ...e }; delete n[keyId]; return n; });
      setMsg('密钥已更新');
      const ks = await get<ProviderKey[]>(`/api/providers/${key.provider_id}/keys`);
      setKeys((k) => ({ ...k, [key.provider_id]: ks }));
    } catch (e: any) { setMsg('更新失败: ' + e.message); }
  };

  return (
    <div>
      <h2 className="page-title">中转管理（官方 API / 第三方中转）</h2>
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{editing ? `编辑中转：${editing.name}` : '新增中转'}</h3>
        {editing && <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>可修改名称、协议、Base URL；Key 留空表示不修改（也可在下方"密钥管理"里加多个 Key）。</p>}
        <div className="form-row"><label>名称</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="form-row">
          <label>协议</label>
          <select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic 兼容</option>
          </select>
        </div>
        <div className="form-row"><label>Base URL（OpenAI 兼容通常以 /v1 结尾）</label><input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://xxx/v1" /></div>
        <div className="form-row"><label>API Key{editing ? '（留空则不修改）' : ''}</label><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? '输入新 Key 则替换' : 'sk-...'} /></div>
        <button className="btn btn-primary" onClick={submit}>{editing ? '保存修改' : '保存'}</button>{' '}
        {editing && <button className="btn btn-secondary" onClick={cancelEdit}>取消</button>}
        {msg && <div className={`msg ${editing ? 'msg-ok' : 'msg-err'}`}>{msg}</div>}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>中转列表（点击"密钥"管理多个 Key）</h3>
        <table>
          <thead><tr><th>名称</th><th>协议</th><th>Base URL</th><th>默认模型</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><span className="tag">{PROTOCOL_LABEL[p.protocol] ?? p.protocol}</span></td>
                <td className="mono">{p.base_url}</td>
                <td className="mono">{Object.keys(p.model_mapping).join(', ') || '—'}</td>
                <td>{p.enabled ? <span className="tag tag-ok">启用</span> : <span className="tag">停用</span>}</td>
                <td>
                  <button className="btn btn-secondary" onClick={() => testConn(p.id)} disabled={testing === p.id}>{testing === p.id ? '测试中…' : '测试连接'}</button>{' '}
                  <button className="btn btn-secondary" onClick={() => toggleKeys(p.id)}>{keysOpen[p.id] ? '收起密钥' : `密钥${(keys[p.id]?.length ?? 0) > 0 ? ` (${keys[p.id]!.length})` : ''}`}</button>{' '}
                  <button className="btn btn-secondary" onClick={() => startEdit(p)}>编辑</button>{' '}
                  <button className="btn btn-danger" onClick={() => { if (window.confirm(`确认删除 Provider「${p.name}」？`)) del(`/api/providers/${p.id}`).then(() => { setList((l) => l.filter((x) => x.id !== p.id)); load(); }).catch((e) => setMsg(e.message)); }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {Object.entries(testResult).map(([id, r]) => (
          r && (
            <div key={id} className={`msg ${r.ok ? 'msg-ok' : 'msg-err'}`}>
              {list.find((p) => p.id === id)?.name}: {r.ok ? `连通正常 (${r.latency_ms}ms)` : `失败[${r.stage}] ${String(r.error).slice(0, 180)} — ${r.hint ?? ''}`}
            </div>
          )
        ))}

        {/* 密钥管理展开区 */}
        {list.map((p) => keysOpen[p.id] && (
          <div key={p.id} className="card" style={{ marginTop: 12, background: 'var(--surface-2)' }}>
            <h4 style={{ marginBottom: 8 }}>{p.name} — 密钥管理（一个中转可配多个 Key，每个 Key 模型不同）</h4>
            {(keys[p.id] ?? []).map((k) => {
              const km = keyModels[k.id];
              return (
                <div key={k.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginBottom: 10, background: 'var(--surface-solid)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{k.name}</strong>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{Object.keys(k.model_mapping).join(', ') || '未配模型'}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn-secondary" onClick={() => loadKeyModels(k.id)}>拉取模型</button>
                    <button className="btn btn-secondary" onClick={() => startEditKey(k.id, k.name)}>编辑</button>
                    <button className="btn btn-danger" onClick={() => deleteKey(k.id)}>删除密钥</button>
                  </div>
                  {editingKey[k.id] && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>
                      <input placeholder="密钥名称" value={editingKey[k.id].name}
                        onChange={(e) => setEditingKey((st) => ({ ...st, [k.id]: { ...st[k.id], name: e.target.value } }))} style={{ flex: 1 }} />
                      <input type="password" placeholder="新 Key（留空不修改）" value={editingKey[k.id].apiKey}
                        onChange={(e) => setEditingKey((st) => ({ ...st, [k.id]: { ...st[k.id], apiKey: e.target.value } }))} style={{ flex: 1 }} />
                      <button className="btn btn-primary" onClick={() => saveEditKey(k.id)}>保存</button>
                      <button className="btn btn-secondary" onClick={() => setEditingKey((st) => { const n = { ...st }; delete n[k.id]; return n; })}>取消</button>
                    </div>
                  )}
                  {km && (
                    <div style={{ marginTop: 8 }}>
                      {km.loading ? <span style={{ fontSize: 12 }}>加载中…</span> : km.models.length === 0 ? (
                        <span style={{ fontSize: 12, color: 'var(--danger)' }}>未拉到模型列表（中转可能不支持 /models 接口，或需检查 Key）</span>
                      ) : (
                        <>
                          {/* 已选模型：可逐个删除 */}
                          {Object.entries(km.checked).filter(([, on]) => on).length > 0 && (
                            <div style={{ marginBottom: 6 }}>
                              <span style={{ fontSize: 12, color: 'var(--success)', marginRight: 6 }}>
                                已选模型（{Object.entries(km.checked).filter(([, on]) => on).length}）：
                              </span>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                                {Object.entries(km.checked).filter(([, on]) => on).map(([m]) => (
                                  <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--success-bg)', borderRadius: 10, padding: '3px 6px 3px 10px', fontSize: 12 }}>
                                    <span className="mono">{m}</span>
                                    <button
                                      title="取消该模型"
                                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--success)', fontSize: 14, lineHeight: 1 }}
                                      onClick={() => toggleKeyModel(k.id, m)}
                                    >×</button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{ marginBottom: 6 }}>
                            <input
                              placeholder={`搜索模型（共 ${km.models.length} 个，输入关键词如 gpt / claude / opus…；勾选即添加，取消即删除）`}
                              value={keyModelSearch[k.id] ?? ''}
                              onChange={(e) => setKeyModelSearch((s) => ({ ...s, [k.id]: e.target.value }))}
                              style={{ width: '100%' }}
                            />
                          </div>
                          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                            <input
                              placeholder="手动添加模型名（中转后台可见但列表没拉出来的，如 gpt-4.1）"
                              value={manualModel[k.id] ?? ''}
                              onChange={(e) => setManualModel((s) => ({ ...s, [k.id]: e.target.value }))}
                              style={{ flex: 1 }}
                            />
                            <button className="btn btn-secondary" onClick={() => addManualModel(k.id)}>添加</button>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 160, overflow: 'auto' }}>
                            {km.models
                              .filter((m) => !(keyModelSearch[k.id] ?? '') || m.toLowerCase().includes((keyModelSearch[k.id] ?? '').toLowerCase()))
                              .map((m) => (
                                <label key={m} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, border: '1px solid #dde3ea', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
                                  <input type="checkbox" checked={!!km.checked[m]} onChange={() => toggleKeyModel(k.id, m)} />
                                  <span className="mono">{m}</span>
                                </label>
                              ))}
                          </div>
                        </>
                      )}
                      <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => saveKeyModels(k.id)}>重新重新保存该密钥的模型</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input placeholder="密钥名称（如：gpt 分组 / claude 分组）" value={newKey[p.id]?.name ?? ''}
                onChange={(e) => setNewKey((n) => ({ ...n, [p.id]: { ...n[p.id], name: e.target.value } }))} style={{ flex: 1 }} />
              <input type="password" placeholder="新 Key" value={newKey[p.id]?.apiKey ?? ''}
                onChange={(e) => setNewKey((n) => ({ ...n, [p.id]: { ...n[p.id], apiKey: e.target.value } }))} style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={() => addKey(p.id)}>新增密钥</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
