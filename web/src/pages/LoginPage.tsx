import { useState } from 'react';
import { post } from '../api';

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await post('/api/auth/login', { password });
      onLogin();
    } catch (ex: any) {
      setErr(ex.message || '登录失败');
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>AI 多 Agent 开发工作台</h1>
        <p className="sub">请输入访问口令</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="访问口令"
          autoFocus
        />
        {err && <div className="msg msg-err">{err}</div>}
        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>
          登录
        </button>
      </form>
    </div>
  );
}
