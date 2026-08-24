import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import ProvidersPage from './pages/ProvidersPage';
import AgentsPage from './pages/AgentsPage';
import PresetsPage from './pages/PresetsPage';
import SettingsPage from './pages/SettingsPage';
import UsagePage from './pages/UsagePage';
import ProjectsPage from './pages/ProjectsPage';
import TasksPage from './pages/TasksPage';
import TaskDetailPage from './pages/TaskDetailPage';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [version, setVersion] = useState('');
  const [waitingCount, setWaitingCount] = useState(0);

  // 需要你操作的任务数（全局轮询，任意页面可见侧边栏角标）
  useEffect(() => {
    if (authed !== true) return;
    const check = () => {
      fetch('/api/tasks', { credentials: 'include', cache: 'no-store' })
        .then((r) => r.json())
        .then((list: any[]) => {
          const n = list.filter((t) => ['WAITING_CLARIFICATION', 'WAITING_DEVDOC_CONFIRM', 'WAITING_ACCEPTANCE', 'WAITING_APPROVAL', 'NEEDS_HUMAN'].includes(t.status)).length;
          setWaitingCount(n);
        })
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [authed]);

  // 版本检测（轮询）：部署新版本后自动刷新，避免加载旧页面（每 30 秒检查）
  useEffect(() => {
    const check = () => {
      fetch('/healthz', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d: any) => {
          setVersion(d.build_id || '');
          if (!d.build_id) return;
          const prev = localStorage.getItem('wb_build_id');
          if (prev && prev !== d.build_id) {
            localStorage.setItem('wb_build_id', d.build_id);
            window.location.reload();
          } else {
            localStorage.setItem('wb_build_id', d.build_id);
          }
        })
        .catch(() => { /* 忽略 */ });
    };
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setAuthed(Boolean(d.ok)))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="loading">加载中…</div>;
  if (!authed) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={() => setAuthed(true)} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <ErrorBoundary>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">AI 开发工作台</div>
          <div className="sidebar-version">版本：{version || '…'}</div>
          <NavLink to="/projects">项目</NavLink>
          <NavLink to="/tasks" badge={waitingCount}>任务</NavLink>
          <NavLink to="/providers">中转管理</NavLink>
          <NavLink to="/agents">智能体</NavLink>
          <NavLink to="/presets">预设方案</NavLink>
          <NavLink to="/usage">用量</NavLink>
          <NavLink to="/settings">设置</NavLink>
          <button
            className="logout"
            onClick={() => {
              fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(() => setAuthed(false));
            }}
          >
            退出
          </button>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/presets" element={<PresetsPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/tasks" replace />} />
          </Routes>
        </main>
      </div>
    </ErrorBoundary>
  );
}

function NavLink({ to, children, badge }: { to: string; children: React.ReactNode; badge?: number }) {
  const loc = useLocation();
  const active = loc.pathname.startsWith(to);
  return (
    <Link to={to} className={active ? 'nav-item active' : 'nav-item'}>
      {children}
      {badge != null && badge > 0 && <span className="nav-badge" title="有任务需要你操作">{badge}</span>}
    </Link>
  );
}
