import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../api';
import { NODE_LABEL, RUN_STATUS, ROLE_LABEL } from '../zh';
import TaskBoard from '../components/TaskBoard';
import RunPanel from '../components/RunPanel';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const WAITING_USER = ['WAITING_CLARIFICATION', 'WAITING_DEVDOC_CONFIRM', 'WAITING_ACCEPTANCE', 'WAITING_APPROVAL', 'NEEDS_HUMAN'];

/** 等你操作时的引导横幅（gpt-pilot checkpoint 参考：明确"下一步做什么"） */
const WAIT_GUIDE: Record<string, { icon: string; text: string; action: string; target: string }> = {
  WAITING_CLARIFICATION: { icon: '💬', text: '架构师正在等你回答需求澄清问题', action: '去回答 →', target: 'gate-clarify' },
  WAITING_DEVDOC_CONFIRM: { icon: '📄', text: '架构师已产出开发文档，等你确认后才会开工', action: '去确认文档 →', target: 'gate-devdoc' },
  WAITING_ACCEPTANCE: { icon: '✅', text: '实现与 QA 已通过，等你验收成品', action: '去验收 →', target: 'gate-accept' },
  WAITING_APPROVAL: { icon: '🔐', text: '有高危操作等待你审批', action: '去审批 →', target: 'gate-approval' },
  NEEDS_HUMAN: { icon: '⚠️', text: '自动流程中断，需要你人工介入处理', action: '查看原因 →', target: 'gate-human' },
};

interface Detail {
  task: any;
  transitions: any[];
  runs: any[];
  reviews: any[];
  devdocs: any[];
  messages: any[];
  subtasks: any[];
  handoffs: any[];
  project: any;
}

const STATUS_LABEL: Record<string, string> = {
  CREATED: '已创建', QUEUED: '排队中', WAITING_CLARIFICATION: '等你澄清',
  ARCHITECTURE: '架构设计', WAITING_DEVDOC_CONFIRM: '等你确认文档',
  PLANNING: '任务拆解', EXECUTING: '执行中', REVIEWING: '审查中', FIXING: '返工中',
  INTEGRATING: '整合中', TESTING: '测试中', WAITING_ACCEPTANCE: '等你验收',
  WAITING_APPROVAL: '等你审批', NEEDS_HUMAN: '需要人工介入',
  COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消',
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [msg, setMsg] = useState('');
  const [comment, setComment] = useState('');
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [interject, setInterject] = useState('');
  const [devdoc, setDevdoc] = useState<{ version: number; content: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  // run_id -> 累计文本（WS 实时追加 + 历史回填）
  const [logs, setLogs] = useState<Record<string, string>>({});
  // run_id -> 是否展开日志面板
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seededRef = useRef<Set<string>>(new Set());
  const logRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(() => {
    get<Detail>(`/api/tasks/${id}/detail`)
      .then((d) => {
        setDetail(d);
        // 回填每个 run 的历史日志（仅首次出现时；刷新页面后重新回填，保证不丢历史）
        for (const r of d.runs ?? []) {
          if (!seededRef.current.has(r.id)) {
            seededRef.current.add(r.id);
            get<{ log: string }>(`/api/runs/${r.id}`)
              .then((data) => {
                if (!data?.log) return;
                setLogs((prev) => {
                  // 实时流领先（长度更大且包含文件内容）则保留实时流；否则用文件回填补全历史
                  const live = prev[r.id] ?? '';
                  return live.length >= data.log.length
                    ? prev
                    : { ...prev, [r.id]: data.log.slice(-20000) };
                });
              })
              .catch(() => { /* 日志文件不存在则忽略 */ });
          }
          // 运行中的 run 默认展开
          if (r.status === 'RUNNING') {
            setExpanded((prev) => (prev[r.id] === undefined ? { ...prev, [r.id]: true } : prev));
          }
        }
        // 交付物（预览链接等）
        get<any[]>(`/api/tasks/${id}/deliveries`)
          .then((rows) => {
            const p = rows.find((x) => x.kind === 'preview' && x.url);
            if (p?.url) setPreviewUrl(p.url);
          })
          .catch(() => {});
      })
      .catch((e) => setMsg(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // WS 实时通道：全量事件处理
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const connect = () => {
      setWsState('connecting');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        setWsState('open');
        retry = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', task_id: id }));
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.task_id && data.task_id !== id) return;
          switch (data.type) {
            case 'agent.output': {
              const runId = data.run_id;
              setLogs((prev) => {
                const cur = (prev[runId] ?? '') + data.chunk;
                // 防止超长运行导致浏览器内存膨胀：只保留最近 5 万字符
                return { ...prev, [runId]: cur.length > 50000 ? cur.slice(-50000) : cur };
              });
              break;
            }
            case 'task.status':
            case 'agent.run.status':
            case 'clarification.question':
            case 'devdoc.confirm.request':
            case 'acceptance.request':
            case 'task.interject':
              load();
              break;
            case 'preview.ready':
              setPreviewUrl(data.url);
              load();
              break;
            case 'task.error':
              setMsg(data.message);
              break;
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsState('closed');
        if (!closed) {
          retry++;
          setTimeout(connect, Math.min(3000 * retry, 15000));
        }
      };
      ws.onerror = () => { /* onclose 会触发重连 */ };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [id, load]);

  // 运行中的日志面板自动滚动到底部
  useEffect(() => {
    for (const r of detail?.runs ?? []) {
      if (r.status === 'RUNNING' && expanded[r.id]) {
        const el = logRefs.current[r.id];
        if (el) el.scrollTop = el.scrollHeight;
      }
    }
  }, [logs, detail, expanded]);

  const action = (path: string, body?: unknown) =>
    post(path, body).then(() => { setMsg('已提交'); load(); }).catch((e) => setMsg(e.message));

  const sendInterject = () => {
    if (!interject.trim()) return;
    action(`/api/tasks/${id}/interject`, { content: interject.trim() });
    setInterject('');
  };

  if (!detail) return <div className="loading">加载中…</div>;
  const { task } = detail;
  const waitingDevdoc = task.status === 'WAITING_DEVDOC_CONFIRM';
  const waitingAccept = task.status === 'WAITING_ACCEPTANCE';
  const waitingClarify = task.status === 'WAITING_CLARIFICATION';
  const active = !TERMINAL.includes(task.status);

  // 当前正在执行的智能体（实时指示"进行到哪一步"）
  const runningRuns = (detail.runs ?? []).filter((r: any) => r.status === 'RUNNING');
  const lastTransition = (detail.transitions ?? []).slice().reverse().find((t: any) => t.to_status === task.status) ?? (detail.transitions ?? []).slice().reverse()[0];

  const showDevdoc = async () => {
    const d = await get<{ version: number; content: string }>(`/api/tasks/${id}/devdoc`);
    setDevdoc(d);
  };

  const clarifyMessages = (detail.messages ?? []).filter((m: any) => m.phase === 'clarify');
  const interjectMessages = (detail.messages ?? []).filter((m: any) => m.phase === 'interject');

  const wsDot = wsState === 'open' ? 'ws-dot ws-open' : wsState === 'connecting' ? 'ws-dot ws-connecting' : 'ws-dot ws-closed';
  const wsText = wsState === 'open' ? '实时已连接' : wsState === 'connecting' ? '连接中…' : '已断开，重连中…';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h2 className="page-title" style={{ marginBottom: 0 }}>任务详情</h2>
        <span className={`ws-indicator ${wsState}`} title="任务状态与智能体输出通过 WebSocket 实时推送">
          <span className={wsDot} />{wsText}
        </span>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{task.title}</strong>{' '}
            <span className="tag">{STATUS_LABEL[task.status] ?? task.status}</span>
            {WAITING_USER.includes(task.status) && (
              <span className="tag tag-warn" style={{ marginLeft: 6 }}>⏳ 需要你操作</span>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
              项目：{detail.project?.name} ｜ 目标：{task.objective}
            </div>
          </div>
          <div>
            {['CREATED', 'NEEDS_HUMAN'].includes(task.status) && (
              <button className="btn btn-primary" onClick={() => action(`/api/tasks/${id}/start`)}>启动任务</button>
            )}
            {active && (
              <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={() => action(`/api/tasks/${id}/cancel`)}>取消任务</button>
            )}
          </div>
        </div>
        {/* 当前进行到哪一步 */}
        <div className="current-step">
          {runningRuns.length > 0 ? (
            <>▶ 正在执行：{runningRuns.map((r: any, i: number) => (
              <span key={r.id}>
                {i > 0 && '、'}
                <strong>{r.agent_name ?? ROLE_LABEL[r.node_id] ?? r.node_id}</strong>
                <span style={{ opacity: 0.75 }}>（{NODE_LABEL[r.node_id] ?? r.node_id}）</span>
              </span>
            ))}</>
          ) : (
            <>当前状态：<strong>{STATUS_LABEL[task.status] ?? task.status}</strong>
              {lastTransition?.reason ? ` — ${lastTransition.reason}` : ''}
              {task.status === 'ARCHITECTURE' && <span style={{ color: 'var(--text-3)' }}>（架构师正在分析/提问…）</span>}
              {task.status === 'EXECUTING' && <span style={{ color: 'var(--text-3)' }}>（执行者正在实现…）</span>}
            </>
          )}
        </div>
        {msg && <div className="msg msg-ok">{msg}</div>}
      </div>

      {/* 等你操作：醒目标语 + 一键定位到对应门 */}
      {WAIT_GUIDE[task.status] && (
        <div className="wait-banner">
          <span className="wait-banner-icon">{WAIT_GUIDE[task.status].icon}</span>
          <span className="wait-banner-text">{WAIT_GUIDE[task.status].text}</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => document.getElementById(WAIT_GUIDE[task.status].target)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            {WAIT_GUIDE[task.status].action}
          </button>
        </div>
      )}

      {/* 执行画板：看板式实时可视化（阶段列 × Agent 卡片） */}
      <TaskBoard
        task={task}
        transitions={detail.transitions}
        runs={detail.runs}
        subtasks={detail.subtasks}
        handoffs={detail.handoffs}
        logs={logs}
        onShowRun={(runId) => {
          setExpanded((prev) => ({ ...prev, [runId]: true }));
          document.getElementById(`run-${runId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />

      {/* 阶段时间线 */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>阶段时间线</h3>
        <div style={{ fontSize: 13 }}>
          {detail.transitions.map((t, i) => (
            <div key={i} style={{ padding: '2px 0' }}>
              <span className="tag">{STATUS_LABEL[t.to_status] ?? t.to_status}</span>{' '}
              <span style={{ color: 'var(--text-3)' }}>
                {new Date(t.ts).toLocaleTimeString('zh-CN')} {t.reason ? `— ${t.reason}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 需要人工介入 */}
      {task.status === 'NEEDS_HUMAN' && (
        <div className="card" id="gate-human" style={{ border: '2px solid var(--danger)', boxShadow: '0 0 20px rgba(248,113,113,.15)' }}>
          <h3>⚠️ 需要人工介入</h3>
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
            自动流程无法继续。<strong>原因：</strong>{lastTransition?.reason ?? '未记录'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            处理方式：① 查看下方智能体日志定位问题（失败/红色状态的 Agent 面板）；② 修复环境、配置或代码冲突后，点击「重新启动任务」从头重跑；③ 也可以在下方「插话给团队」补充说明。
          </p>
          <button className="btn btn-primary" onClick={() => action(`/api/tasks/${id}/start`)}>重新启动任务</button>
        </div>
      )}

      {/* 开发文档确认门 */}
      {waitingDevdoc && (
        <div className="card" id="gate-devdoc" style={{ border: '2px solid #2f6fed' }}>
          <h3>📄 开发文档确认</h3>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>架构师已产出开发文档，请审阅后确认开始执行；或打回让架构师修改。</p>
          <button className="btn btn-secondary" style={{ margin: '8px 0' }} onClick={showDevdoc}>查看开发文档</button>
          {devdoc && (
            <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 6, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {devdoc.content}
            </pre>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => action(`/api/tasks/${id}/devdoc/confirm`)}>确认，开始执行</button>{' '}
            <button className="btn btn-danger" onClick={() => action(`/api/tasks/${id}/devdoc/reject`, { comment })}>打回修改</button>{' '}
            <input style={{ width: 300 }} placeholder="打回意见（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
      )}

      {/* 澄清门：架构师与你的对话（等待时或架构阶段均展示） */}
      {(waitingClarify || task.status === 'ARCHITECTURE' || clarifyMessages.length > 0) && (
        <div className="card" id="gate-clarify" style={{ border: '1px solid rgba(251, 191, 36, 0.4)', boxShadow: '0 0 20px rgba(251, 191, 36, 0.08)' }}>
          <h3>💬 与架构师的对话</h3>
          <div style={{ maxHeight: 320, overflow: 'auto', marginBottom: 12 }}>
            {clarifyMessages.map((m: any, i: number) => (
              <div key={i} style={{
                margin: '6px 0',
                padding: '10px 14px',
                borderRadius: 12,
                maxWidth: '85%',
                background: m.role === 'agent' ? 'var(--surface-2)' : 'var(--accent-soft)',
                border: '1px solid var(--border)',
                marginLeft: m.role === 'agent' ? 0 : 'auto',
                whiteSpace: 'pre-wrap',
                fontSize: 13.5,
              }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                  {m.role === 'agent' ? '🤖 架构师' : '👤 你'} · {new Date(m.created_at).toLocaleTimeString('zh-CN')}
                </div>
                {m.content.slice(0, 3000)}
              </div>
            ))}
            {clarifyMessages.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                {task.status === 'ARCHITECTURE' ? '架构师正在分析需求，如有疑问会在此提问…' : '暂无对话记录'}
              </div>
            )}
          </div>
          {waitingClarify && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ flex: 1 }} placeholder="你的回答…（回答后架构师会继续）" value={clarifyAnswer} onChange={(e) => setClarifyAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && clarifyAnswer.trim()) { action(`/api/tasks/${id}/clarify-answer`, { content: clarifyAnswer }); setClarifyAnswer(''); } }} />
              <button className="btn btn-primary" onClick={() => { action(`/api/tasks/${id}/clarify-answer`, { content: clarifyAnswer }); setClarifyAnswer(''); }}>发送回答</button>
            </div>
          )}
          {task.status === 'ARCHITECTURE' && !waitingClarify && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>架构师正在工作，完成提问或产出文档后会自动通知你…</div>
          )}
        </div>
      )}

      {/* 验收门 */}
      {waitingAccept && (
        <div className="card" id="gate-accept" style={{ border: '2px solid #2e9e4f' }}>
          <h3>✅ 请验收成品</h3>
          {previewUrl && (
            <p style={{ fontSize: 13 }}>
              网页预览已就绪：<a href={previewUrl} target="_blank" rel="noreferrer">{previewUrl}</a>（可点击打开）
            </p>
          )}
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            实现与 QA 已通过。查看项目目录 {detail.project?.repo_path} 中的产物；验收通过后任务完成，不通过则退回修改。
          </p>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => action(`/api/tasks/${id}/accept`)}>验收通过</button>{' '}
            <button className="btn btn-danger" onClick={() => action(`/api/tasks/${id}/reject-acceptance`, { comment })}>打回修改</button>{' '}
            <input style={{ width: 300 }} placeholder="打回意见（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
      )}

      {/* 预览就绪（非验收等待期也可展示） */}
      {previewUrl && !waitingAccept && (
        <div className="card" style={{ border: '2px solid #2e9e4f' }}>
          <h3>🚀 网页预览已就绪</h3>
          <p style={{ fontSize: 13 }}>
            <a href={previewUrl} target="_blank" rel="noreferrer">{previewUrl}</a>（点击在新窗口打开）
          </p>
        </div>
      )}

      {/* 插话给团队：执行中随时可以插手 */}
      {active && (
        <div className="card" style={{ border: '1px solid rgba(96, 165, 250, 0.35)' }}>
          <h3 style={{ marginBottom: 4 }}>📨 插话给团队</h3>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
            执行中随时可补充需求、提醒或调整方向；消息会在下一轮实现 / 返工时自动并入执行指令（开发文档 FR-10）。
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ flex: 1 }} placeholder="例如：登录功能请同时支持手机号验证码…" value={interject} onChange={(e) => setInterject(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendInterject(); }} />
            <button className="btn btn-primary" onClick={sendInterject}>发送插话</button>
          </div>
          {interjectMessages.length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 180, overflow: 'auto' }}>
              {interjectMessages.map((m: any, i: number) => (
                <div key={i} style={{ fontSize: 13, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--info)' }}>📨 你插话</span>{' '}
                  <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{new Date(m.created_at).toLocaleTimeString('zh-CN')}</span>
                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{m.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 智能体运行记录：每卡一个 run，日志实时流 + 历史回填 */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>智能体运行记录</h3>
        {(detail.runs ?? []).length === 0 && <div style={{ fontSize: 13, color: 'var(--text-3)' }}>暂无智能体运行记录</div>}
        {(detail.runs ?? []).map((r: any) => (
          <RunPanel
            key={r.id}
            run={r}
            logText={logs[r.id] ?? ''}
            handoffs={detail.handoffs}
            expanded={expanded[r.id] ?? false}
            onToggle={() => setExpanded((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
            logRef={(el) => { logRefs.current[r.id] = el; }}
          />
        ))}
      </div>

      {/* 各角色 Handoff 交接摘要 */}
      {(detail.handoffs ?? []).length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>交接摘要（Handoff）</h3>
          {(detail.handoffs ?? []).map((h: any, i: number) => (
            <div key={i} style={{ padding: '8px 0', borderBottom: i < detail.handoffs.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                <span className="tag tag-info">{NODE_LABEL[h.node_id] ?? h.node_id}</span>{' '}
                <strong>{h.agent_name ?? '—'}</strong>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{h.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
