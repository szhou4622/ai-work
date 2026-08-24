import { useEffect, useState } from 'react';
import { get, put } from '../api';

const KEYS = [
  { key: 'executor_cap', label: '执行者数量上限', type: 'number', hint: '一个任务最多并行几个执行者（服务器内存有限，建议 2-4）' },
  { key: 'max_concurrent_tasks', label: '并发任务上限', type: 'number', hint: '同时运行多少个任务' },
  { key: 'review_max_iterations', label: '审查返工次数上限', type: 'number', hint: '审查不通过最多退回返工几次，超限进入“需要人工介入”' },
  { key: 'approval_policy', label: '高危操作审批策略', type: 'select', hint: '删除/推送/发布等危险命令的处理方式', options: [
    { value: 'auto_allow', label: '自动允许（不提示直接执行）' },
    { value: 'require_approval', label: '需人工确认（默认，推荐）' },
    { value: 'forbid', label: '禁止执行' },
  ] },
  { key: 'preview_port_range', label: '预览端口段', type: 'text', hint: '网页项目预览链接使用的端口范围（需在服务器防火墙放行）' },
  { key: 'auth_required', label: '登录开关', type: 'select', hint: '是否要求访问口令登录（建议稳定后开启）', options: [
    { value: 'false', label: '关闭（任何人可访问）' },
    { value: 'true', label: '开启（需要登录口令）' },
  ] },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');

  useEffect(() => { get('/api/settings').then(setSettings).catch(() => {}); }, []);

  const save = async () => {
    try {
      await put('/api/settings', settings);
      setMsg('已保存');
      setTimeout(() => setMsg(''), 2000);
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div>
      <h2 className="page-title">系统设置</h2>
      <div className="card">
        <h3>任务与执行</h3>
        {KEYS.slice(0, 3).map((k) => (
          <div className="form-row" key={k.key}>
            <label>{k.label}</label>
            <input
              type={k.type}
              value={String(settings[k.key] ?? '')}
              onChange={(e) => setSettings({ ...settings, [k.key]: k.type === 'number' ? Number(e.target.value) : e.target.value })}
              style={{ maxWidth: 220 }}
            />
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{k.hint}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>安全与访问</h3>
        {KEYS.slice(3).map((k) => (
          <div className="form-row" key={k.key}>
            <label>{k.label}</label>
            {k.type === 'select' ? (
              <select
                value={String(settings[k.key] ?? '')}
                onChange={(e) => setSettings({ ...settings, [k.key]: e.target.value })}
                style={{ maxWidth: 320 }}
              >
                {k.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={String(settings[k.key] ?? '')} onChange={(e) => setSettings({ ...settings, [k.key]: e.target.value })} style={{ maxWidth: 220 }} />
            )}
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{k.hint}</div>
          </div>
        ))}
      </div>

      <button className="btn btn-primary" onClick={save}>保存设置</button>
      {msg && <div className="msg msg-ok">{msg}</div>}
    </div>
  );
}
