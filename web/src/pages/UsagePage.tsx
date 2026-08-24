import { useEffect, useState } from 'react';
import { get } from '../api';
import { stageLabel } from '../zh';

export default function UsagePage() {
  const [data, setData] = useState<any>(null);
  const [billing, setBilling] = useState<any>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    get('/api/usage').then(setData).catch((e) => setMsg(e.message));
    get('/api/billing/usage').then(setBilling).catch(() => {});
  }, []);

  if (msg) return <div className="msg msg-err">{msg}</div>;
  if (!data) return <div className="loading">加载中…</div>;
  const t = data.total;

  const accounts = billing?.accounts ?? [];

  return (
    <div>
      <h2 className="page-title">用量与费用</h2>

      {/* 中转账户真实用量 */}
      {accounts.length > 0 && (
        <div className="card">
          <h3>中转账户真实用量（从中转接口实时读取，非估算）</h3>
          <table>
            <thead><tr><th>中转</th><th>密钥</th><th>近 30 天累计用量</th></tr></thead>
            <tbody>
              {accounts.map((a: any, i: number) => (
                <tr key={i}>
                  <td>{a.provider}</td>
                  <td>{a.key}</td>
                  <td>
                    {a.unsupported
                      ? <span className="tag">该中转不支持用量查询</span>
                      : <strong>${(a.usd ?? 0).toFixed(2)}</strong>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            数据来自各中转的 /dashboard/billing/usage 接口（OpenAI 口径，美分 ÷100 = 美元）。
          </p>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card glow">
          <div className="stat-label">总请求</div>
          <div className="stat-value">{t.requests}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Tokens（输入 / 输出）</div>
          <div className="stat-value" style={{ fontSize: 17 }}>{t.prompt_tokens.toLocaleString()} / {t.completion_tokens.toLocaleString()}</div>
          <div className="stat-sub">合计 {t.total_tokens.toLocaleString()}</div>
        </div>
        <div className="stat-card glow">
          <div className="stat-label">估算费用（USD）</div>
          <div className="stat-value">${t.cost_est.toFixed(4)}</div>
          <div className="stat-sub">按模型价格表估算（API 线路）</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">订阅线路</div>
          <div className="stat-value" style={{ fontSize: 15 }}>不产生费用</div>
          <div className="stat-sub">剩余额度到 OpenAI/ChatGPT 账号查看</div>
        </div>
      </div>

      <div className="card">
        <h3>按阶段（智能体运行）</h3>
        <table>
          <thead><tr><th>阶段</th><th>请求</th><th>输入 tokens</th><th>输出 tokens</th><th>费用（估算）</th></tr></thead>
          <tbody>
            {data.byStage.map((r: any) => (
              <tr key={r.stage}>
                <td>{stageLabel(r.stage)} <span className="mono" style={{ color: 'var(--text-3)' }}>({r.model || '—'})</span></td>
                <td>{r.requests}</td>
                <td>{r.prompt_tokens.toLocaleString()}</td>
                <td>{r.completion_tokens.toLocaleString()}</td>
                <td>${Number(r.cost_est).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>明细（最近 500 条）</h3>
        <table>
          <thead><tr><th>阶段</th><th>模型</th><th>请求</th><th>输入</th><th>输出</th><th>费用</th><th>备注</th></tr></thead>
          <tbody>
            {data.detail.map((r: any) => (
              <tr key={r.id}>
                <td>{stageLabel(r.stage)}</td>
                <td className="mono">{r.model || '—'}</td>
                <td>{r.requests}</td>
                <td>{r.prompt_tokens.toLocaleString()}</td>
                <td>{r.completion_tokens.toLocaleString()}</td>
                <td>{r.available === 0 ? '订阅' : `$${Number(r.cost_est).toFixed(4)}`}</td>
                <td className="mono" style={{ color: 'var(--text-3)' }}>{r.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>
          费用为估算值：按内置模型价格表（USD/百万 tokens）计算；订阅线路（Codex/Claude Code）不产生费用。
        </p>
      </div>
    </div>
  );
}
