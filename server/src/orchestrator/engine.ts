import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import type { TaskStatus } from '@workbench/shared';
import { getDb } from '../db/index.js';
import type { SecretStore } from '../secrets/store.js';
import type { WsHub } from './ws.js';
import { transition } from './state-machine.js';
import { runApiAgent, resolveApiRun } from '../runtimes/api/loop.js';
import { codexDetect, codexRun, parseCodexUsage } from '../runtimes/cli/codex.js';
import { claudeDetect, claudeRun } from '../runtimes/cli/claude-code.js';
import { DATA_DIR } from '../config.js';
import { recordAudit } from '../observability/audit.js';
import { startPreview, recordDelivery } from '../delivery/preview.js';

export interface GateDecision {
  decision: string;
  comment?: string;
}

interface TaskContext {
  taskId: string;
  cancelled: boolean;
  resolvers: Map<string, (d: GateDecision) => void>;
  reviewIter: number;
  qaIter: number;
  acceptIter: number;
  devdocVersion: number;
  repo: string;
  clarifyTranscript: string[];
  lastReviewIssues: string;
  interjectCursor: number;
}

// 优化：支持持久化和恢复的上下文
function serializeContext(tc: TaskContext): string {
  return JSON.stringify({
    taskId: tc.taskId,
    reviewIter: tc.reviewIter,
    qaIter: tc.qaIter,
    acceptIter: tc.acceptIter,
    devdocVersion: tc.devdocVersion,
    repo: tc.repo,
    clarifyTranscript: tc.clarifyTranscript,
    lastReviewIssues: tc.lastReviewIssues,
    interjectCursor: tc.interjectCursor,
  });
}

function deserializeContext(taskId: string, serialized: string): TaskContext {
  const data = JSON.parse(serialized);
  return {
    taskId,
    cancelled: false,
    resolvers: new Map(),
    reviewIter: data.reviewIter || 0,
    qaIter: data.qaIter || 0,
    acceptIter: data.acceptIter || 0,
    devdocVersion: data.devdocVersion || 1,
    repo: data.repo || '',
    clarifyTranscript: data.clarifyTranscript || [],
    lastReviewIssues: data.lastReviewIssues || '',
    interjectCursor: data.interjectCursor || 0,
  };
}

function saveContext(tc: TaskContext): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET runtime_context = ? WHERE id = ?').run(serializeContext(tc), tc.taskId);
}

const contexts = new Map<string, TaskContext>();
const ACTIVE_STATUSES = [
  'CREATED', 'QUEUED', 'WAITING_CLARIFICATION', 'ARCHITECTURE', 'WAITING_DEVDOC_CONFIRM',
  'PLANNING', 'EXECUTING', 'REVIEWING', 'FIXING', 'INTEGRATING', 'TESTING',
  'WAITING_ACCEPTANCE', 'WAITING_APPROVAL',
];

export interface EngineDeps {
  secrets: SecretStore;
  hub: WsHub;
}

function getContext(taskId: string): TaskContext {
  const tc = contexts.get(taskId);
  if (!tc) throw new Error(`任务控制器不存在: ${taskId}`);
  return tc;
}

export function isRunning(taskId: string): boolean {
  return contexts.has(taskId);
}

/** 取出并消费一条已落库、尚未使用的人机门决定 */
function takePersistedGate(taskId: string, name: string): GateDecision | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM gate_decisions WHERE task_id = ? AND gate = ? AND consumed_at IS NULL ORDER BY created_at ASC LIMIT 1',
  ).get(taskId, name) as any;
  if (!row) return null;
  db.prepare('UPDATE gate_decisions SET consumed_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { decision: row.decision, comment: row.comment ?? undefined };
}

function waitGate(tc: TaskContext, name: string): Promise<GateDecision> {
  // 重启后可能用户早已点过按钮：先消费已落库的决定，避免永久等待。
  const persisted = takePersistedGate(tc.taskId, name);
  if (persisted) return Promise.resolve(persisted);
  return new Promise((resolve) => tc.resolvers.set(name, resolve));
}

/**
 * 人机门恢复入口（供路由调用）。
 * 决定先落库再唤醒：任务未在内存中（例如服务刚重启）时写库并重新拉起任务，
 * 由 waitGate 消费，而不是直接把用户操作丢掉。
 */
export function resumeGate(taskId: string, name: string, decision: string, comment?: string): boolean {
  const db = getDb();
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) return false;

  const tc = contexts.get(taskId);
  const resolver = tc?.resolvers.get(name);
  if (tc && resolver) {
    tc.resolvers.delete(name);
    resolver({ decision, comment });
    return true;
  }

  // 内存里没有等待者：只有确实停在对应等待状态时才落库补偿。
  const expected: Record<string, string> = {
    clarify: 'WAITING_CLARIFICATION',
    devdoc: 'WAITING_DEVDOC_CONFIRM',
    acceptance: 'WAITING_ACCEPTANCE',
  };
  if (task.status !== expected[name]) return false;

  db.prepare(
    'INSERT INTO gate_decisions (id, task_id, gate, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), taskId, name, decision, comment ?? null, Date.now());

  if (!contexts.has(taskId)) {
    startTask(taskId).catch((err) => console.error('resumeGate restart failed', err));
  }
  return true;
}

export function cancelTask(taskId: string): boolean {
  const tc = contexts.get(taskId);
  if (!tc) return false;
  tc.cancelled = true;
  return true;
}

/* ========== 辅助 ========== */

function ensureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, '.git'))) {
    execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  }
  git(dir, ['config', 'user.name', 'AI Workbench']);
  git(dir, ['config', 'user.email', 'workbench@local']);
}

/** 工作目录有改动则自动提交（确保 Worktree 整合时有可合并的提交） */
function commitWorkdir(workdir: string, message: string): void {
  const st = execSync2('git', ['status', '--porcelain'], workdir);
  if (!st.output.trim()) return;
  execSync2('git', ['add', '-A'], workdir);
  const c = execSync2('git', ['commit', '-m', message], workdir);
  if (!c.ok) console.error('[engine] commit failed:', c.output.slice(0, 300));
}

function resolveAgent(tc: TaskContext, role: string): any {
  const db = getDb();
  const task = db.prepare('SELECT preset_id, agent_overrides FROM tasks WHERE id = ?').get(tc.taskId) as any;
  let agent: any = null;

  // 1. 任务级覆盖（发布任务时微调的线路，优先于预设）
  if (task?.agent_overrides) {
    const overrides = JSON.parse(task.agent_overrides || '{}');
    const aid = overrides[role];
    if (aid) agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(aid) as any;
  }
  // 2. 预设方案
  if (!agent && task?.preset_id) {
    const preset = db.prepare('SELECT role_agent_map FROM presets WHERE id = ?').get(task.preset_id) as any;
    if (preset) {
      const map = JSON.parse(preset.role_agent_map || '{}');
      const aid = map[role];
      if (aid) agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(aid) as any;
    }
  }
  // 3. 角色默认
  if (!agent) {
    agent = db.prepare('SELECT * FROM agents WHERE role_id = ? LIMIT 1').get(`role-${role}`) as any;
  }
  return agent;
}

function getRuntime(runtimeId: string): any {
  return getDb().prepare('SELECT * FROM runtimes WHERE id = ?').get(runtimeId) as any;
}

function resolveEnvForCli(agent: any, secrets: SecretStore): Record<string, string> {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(agent.provider_id) as any;
  if (!provider) return {};
  const key = secrets.get(provider.secret_ref);
  if (provider.protocol === 'anthropic') {
    return { ANTHROPIC_BASE_URL: provider.base_url, ANTHROPIC_AUTH_TOKEN: key ?? '' };
  }
  return {};
}

function extractReport(output: string): string | null {
  const m = output.match(/REPORT_OK:\s*([\s\S]{0,2000})/);
  return m ? m[1].trim() : null;
}

/**
 * 结论判定：优先读结构化首行 `VERDICT: PASS|FAIL`（角色提示词已要求这么写）。
 *
 * 不能对全文做 /\bFAIL\b/ 匹配：审查者写"未发现 FAIL 项"、输出里出现
 * fail.test.ts 之类的文件名、或复述上一轮失败原因，都会被误判成 FAIL，
 * 把任务推进无谓的返工直至耗尽配额。
 */
function verdictOf(report: string | null, output: string, ok: boolean): 'PASS' | 'FAIL' {
  if (!ok) return 'FAIL';
  const text = (report ?? output ?? '').trim();
  if (!text) return 'FAIL';

  // 1) 结构化判定：扫描前若干行，找 VERDICT:/REPORT_OK: 显式结论
  const lines = text.split('\n').slice(0, 5);
  for (const line of lines) {
    const m = line.match(/^\s*(?:VERDICT|REPORT_OK)\s*[:：]\s*(PASS|FAIL)\b/i);
    if (m) return m[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
  }

  // 2) 回退：全文找显式结论标记（模型把结论写在正文中部时）
  const explicit = text.match(/(?:VERDICT|REPORT_OK)\s*[:：]\s*(PASS|FAIL)\b/i);
  if (explicit) {
    console.warn('[engine] 结论不在首行，已回退全文匹配（建议检查角色提示词是否被覆盖）');
    return explicit[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
  }

  // 3) 无结构化结论：保守判 FAIL，但记录告警便于排查
  console.warn(`[engine] 未找到结构化结论（VERDICT: PASS|FAIL），保守判 FAIL。输出片段：${text.slice(0, 200)}`);
  return 'FAIL';
}

/** 执行一次角色运行（CLI 或 API），落库 AgentRun/Handoff 并流式推送 */
async function executeRole(
  tc: TaskContext,
  role: string,
  context: string,
  deps: EngineDeps,
  nodeId: string,
  workdirOverride?: string,
  agentIdOverride?: string,
): Promise<{ runId: string; report: string | null; output: string; ok: boolean }> {
  const db = getDb();
  const agent = agentIdOverride
    ? (db.prepare('SELECT * FROM agents WHERE id = ?').get(agentIdOverride) as any)
    : resolveAgent(tc, role);
  if (!agent) throw new Error(`未配置 ${role} 角色的 Agent（请先在 Agent 管理/预设方案中配置）`);
  const runtime = getRuntime(agent.runtime_id);
  if (!runtime) throw new Error(`Agent ${agent.name} 的 Runtime 不存在`);
  const workdir = workdirOverride ?? tc.repo;

  // 提示词 = 角色模板（可被 Agent 自定义提示词覆盖）+ 任务上下文（含上下文预算控制，防止"提示词太长"）
  const roleRow = db.prepare('SELECT prompt_template FROM roles WHERE id = ?').get(agent.role_id) as any;
  const template = (agent.prompt_override || roleRow?.prompt_template || '').trim();
  const MAX_CONTEXT_CHARS = 14000; // 注入上下文字符上限（模型上下文窗口保护）
  let ctx = context.trim();
  if (ctx.length > MAX_CONTEXT_CHARS) {
    ctx = ctx.slice(0, MAX_CONTEXT_CHARS) + '\n\n...(上下文过长，已截断，请按现有信息继续)';
  }
  const input = [template, ctx].filter(Boolean).join('\n\n');

  const runId = crypto.randomUUID();
  const runsDir = path.join(DATA_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const logFile = path.join(runsDir, `${runId}.log`);

  db.prepare(
    'INSERT INTO agent_runs (id, task_id, node_id, agent_id, status, started_at, output_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(runId, tc.taskId, nodeId, agent.id, 'RUNNING', Date.now(), logFile);

  const onEvent = (chunk: string) => {
    appendFileSync(logFile, chunk);
    deps.hub.publish({ type: 'agent.output', task_id: tc.taskId, run_id: runId, chunk });
  };
  onEvent(`\n[${role}] 开始（agent=${agent.name}, runtime=${runtime.type}, workdir=${workdir}）\n`);

  let report: string | null = null;
  let output = '';
  let ok = true;
  let exitInfo: Record<string, unknown> = {};

  if (runtime.type === 'api') {
    try {
      const runReq = resolveApiRun(db, agent, deps.secrets, input, workdir);
      runReq.maxSteps = 100; // 增加到100以支持复杂审查任务
      // 架构/计划节点要产出架构文档与开发文档，输出预算不足会把文档截断在半句话，
      // 后续校验必然失败并触发无意义返工，所以这两类节点单独放宽。
      if (nodeId === 'clarify' || nodeId === 'plan') runReq.maxTokens = 16384;
      const result = await runApiAgent(runReq, onEvent);
      report = result.report ?? null;
      output = result.output;
      ok = result.status === 'completed';
      exitInfo = { status: result.status, usage: result.usage };
      // 用量入库（开发文档 §9.9）
      db.prepare(
        `INSERT INTO usage_records (id, task_id, agent_run_id, billing_route_id, requests, prompt_tokens, completion_tokens, cached_tokens, duration_ms, cost_est, currency, available, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'USD', 1, ?)`,
      ).run(
        crypto.randomUUID(), tc.taskId, runId, agent.billing_route_id,
        result.usage.requests, result.usage.prompt_tokens, result.usage.completion_tokens,
        0, `role=${role}`,
      );
    } catch (err) {
      ok = false;
      output = err instanceof Error ? err.message : String(err);
      onEvent(`\n[error] ${output}\n`);
      exitInfo = { error: output };
    }
  } else if (runtime.type === 'cli') {
    let installed = false;
    if (runtime.id === 'rt-codex' || runtime.executable === 'codex') {
      installed = (await codexDetect()).installed;
    } else if (runtime.id === 'rt-claude' || runtime.executable === 'claude') {
      installed = (await claudeDetect()).installed;
    }
    if (!installed) {
      ok = false;
      output = `CLI 未安装或不可用（${runtime.executable}）。请先在服务器安装并登录该 CLI。`;
      onEvent(`\n[error] ${output}\n`);
      exitInfo = { error: 'cli_not_installed' };
    } else {
      const env = resolveEnvForCli(agent, deps.secrets);
      const isCodex = runtime.id === 'rt-codex' || runtime.executable === 'codex';
      const res = isCodex
        ? await codexRun({ prompt: input, cwd: workdir, env, timeoutMs: 30 * 60 * 1000, onChunk: onEvent })
        : await claudeRun({ prompt: input, cwd: workdir, env, timeoutMs: 30 * 60 * 1000, onChunk: onEvent });
      output = res.output;
      ok = res.code === 0;
      report = extractReport(output);
      exitInfo = { code: res.code, sessionRef: res.sessionRef };
      // 订阅线路用量：尽力记录 token（剩余额度需在 OpenAI 账号查看，不虚构金额）
      const usage = isCodex ? parseCodexUsage(output) : null;
      if (usage) {
        db.prepare(
          `INSERT INTO usage_records (id, task_id, agent_run_id, billing_route_id, requests, prompt_tokens, completion_tokens, cached_tokens, duration_ms, cost_est, currency, available, note)
           VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0, 0, 'USD', 0, ?)`,
        ).run(crypto.randomUUID(), tc.taskId, runId, agent.billing_route_id, usage.prompt_tokens, usage.completion_tokens, 'subscription-cli:codex');
      } else {
        db.prepare(
          `INSERT INTO usage_records (id, task_id, agent_run_id, billing_route_id, requests, prompt_tokens, completion_tokens, cached_tokens, duration_ms, cost_est, currency, available, note)
           VALUES (?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 'USD', 0, ?)`,
        ).run(crypto.randomUUID(), tc.taskId, runId, agent.billing_route_id, 'subscription-cli:usage-unavailable');
      }
    }
  } else {
    ok = false;
    output = `未知 Runtime 类型: ${runtime.type}`;
  }

  // 优化：记录失败时的详细错误信息
  if (!ok) {
    const errorSummary = output.slice(0, 500);
    onEvent(`\n[engine] 执行失败：${errorSummary}\n`);
    exitInfo = { ...exitInfo, error: errorSummary };
  }

  db.prepare('UPDATE agent_runs SET status = ?, ended_at = ?, exit_info = ? WHERE id = ?').run(
    ok ? 'COMPLETED' : 'FAILED', Date.now(), JSON.stringify(exitInfo), runId,
  );
  db.prepare(
    'INSERT INTO handoffs (id, agent_run_id, summary, files_changed, decisions, risks, next_context) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    crypto.randomUUID(), runId, report ?? output.slice(0, 1000), '[]', '[]', '[]', `role=${role}`,
  );
  deps.hub.publish({ type: 'agent.run.status', task_id: tc.taskId, run_id: runId, status: ok ? 'COMPLETED' : 'FAILED' });
  return { runId, report, output, ok };
}

/**
 * 兜底：架构师把开发文档写到了别处时，找出最可能的那一份并归位到 docs/devdoc.md。
 * 提示词已明确要求路径，这里只处理模型不听话的情况，避免流水线直接卡死。
 */
function recoverMisplacedDevdoc(repo: string): boolean {
  const target = path.join(repo, 'docs', 'devdoc.md');
  const candidates = [
    'devdoc.md', 'DEVDOC.md',
    path.join('docs', 'DEVDOC.md'), path.join('docs', 'dev-doc.md'),
    path.join('docs', 'design.md'), path.join('docs', 'devdoc.markdown'),
    'design.md', 'DESIGN.md', 'ARCHITECTURE.md',
  ];
  for (const rel of candidates) {
    const p = path.join(repo, rel);
    if (p === target || !existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8');
      if (content.trim().length < 200) continue; // 太短，不像开发文档
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
      console.warn(`[engine] 开发文档位置不符（${rel}），已复制到 docs/devdoc.md`);
      return true;
    } catch { /* 读取失败则继续尝试下一个候选 */ }
  }
  return false;
}

function registerDevdoc(tc: TaskContext): { version: number; content: string } | null {
  const db = getDb();
  const p = path.join(tc.repo, 'docs', 'devdoc.md');
  if (!existsSync(p) && !recoverMisplacedDevdoc(tc.repo)) return null;
  if (!existsSync(p)) return null;
  const version = tc.devdocVersion + 1;
  tc.devdocVersion = version;
  db.prepare(
    'INSERT INTO devdocs (id, task_id, version, content_path, status) VALUES (?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), tc.taskId, version, p, 'draft');
  return { version, content: readFileSync(p, 'utf-8').slice(0, 20000) };
}

function readDevdoc(tc: TaskContext): string {
  const p = path.join(tc.repo, 'docs', 'devdoc.md');
  return existsSync(p) ? readFileSync(p, 'utf-8').slice(0, 12000) : '';
}

async function finishTask(tc: TaskContext, deps: EngineDeps, status: TaskStatus, reason: string): Promise<void> {
  if (status === 'COMPLETED') {
    const db = getDb();
    const summary = `任务完成：${reason}`;
    db.prepare(
      'INSERT INTO project_memories (id, project_id, task_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), (db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(tc.taskId) as any).project_id, tc.taskId, 'task_summary', summary, Date.now());
    db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(Date.now(), tc.taskId);
  }
  // 优化：保存最终上下文
  saveContext(tc);
  transition(tc.taskId, status as any, { reason }, deps.hub);
  recordAudit(getDb(), 'system', 'task:finish', tc.taskId, { status, reason });
  contexts.delete(tc.taskId);
  await dequeueNext(tc.taskId);
}

/** 同项目排队（开发文档 §3.1 / FR-16）：任务结束 → 启动同项目下一个排队任务 */
async function dequeueNext(finishedTaskId: string): Promise<void> {
  const db = getDb();
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(finishedTaskId) as any;
  if (!task) return;
  const next = db.prepare(
    `SELECT id FROM tasks WHERE project_id = ? AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 1`,
  ).get(task.project_id) as any;
  if (next) {
    db.prepare("UPDATE tasks SET status = 'CREATED', queue_order = NULL WHERE id = ?").run(next.id);
    startTask(next.id).catch((err) => console.error('dequeue start failed', err));
  }
}

/* ========== 主流程（标准工作流 · 串行版） ========== */

export async function startTask(taskId: string): Promise<void> {
  const db = getDb();
  const deps: EngineDeps = { secrets: (globalThis as any).__workbenchSecrets, hub: (globalThis as any).__workbenchHub };
  if (!deps.secrets || !deps.hub) throw new Error('engine 未初始化');
  if (contexts.has(taskId)) return;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) throw new Error('任务不存在');

  // 同项目排队：已有活动任务 → QUEUED
  const active = db.prepare(
    `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND id != ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
  ).get(task.project_id, taskId, ...ACTIVE_STATUSES) as { c: number };
  if (active.c > 0) {
    transition(taskId, 'QUEUED', { reason: '同项目已有任务运行中，自动排队' }, deps.hub);
    return;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as any;
  if (!project) throw new Error('项目不存在');
  const repo = project.repo_path || path.join(DATA_DIR, 'projects', project.id);
  ensureRepo(repo);

  // 优化：恢复已有的运行时上下文（支持服务重启后继续）
  let tc: TaskContext;
  if (task.runtime_context) {
    try {
      tc = deserializeContext(taskId, task.runtime_context);
      tc.cancelled = false;
      tc.resolvers = new Map();
      console.log(`[engine] 恢复任务上下文: ${taskId}, status=${task.status}`);
    } catch (err) {
      console.warn(`[engine] 恢复上下文失败，使用新上下文:`, err);
      tc = {
        taskId, cancelled: false, resolvers: new Map(),
        reviewIter: 0, qaIter: 0, acceptIter: 0, devdocVersion: 0, repo, clarifyTranscript: [], lastReviewIssues: '', interjectCursor: 0,
      };
    }
  } else {
    tc = {
      taskId, cancelled: false, resolvers: new Map(),
      reviewIter: 0, qaIter: 0, acceptIter: 0, devdocVersion: 0, repo, clarifyTranscript: [], lastReviewIssues: '', interjectCursor: 0,
    };
  }
  contexts.set(taskId, tc);

  try {
    await runPipeline(tc, task, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[engine] task ${taskId} error:`, msg);
    if (contexts.has(taskId)) {
      await finishTask(tc, deps, 'NEEDS_HUMAN', `执行异常：${msg}`);
    }
  }
}

async function runPipeline(tc: TaskContext, task: any, deps: EngineDeps): Promise<void> {
  const maxReview = Number((getDb().prepare("SELECT value FROM settings WHERE key='review_max_iterations'").get() as any)?.value ?? 3);

  // ========== 断点续传：检查当前状态，跳过已完成的阶段 ==========
  const currentStatus = task.status;
  console.log(`[engine] runPipeline开始, 当前任务状态: ${currentStatus}`);

  // 已确认的开发文档（如果有）
  let devdoc: { version: number; content: string } | null = null;

  // 检查是否已有confirmed的devdoc
  const existingDevdoc = getDb().prepare(
    "SELECT * FROM devdocs WHERE task_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1"
  ).get(tc.taskId) as any;

  // 判断哪些阶段需要跳过
  // 关键：如果有confirmed的devdoc，就跳过架构阶段（不管当前状态是什么）
  const hasConfirmedDevdoc = !!existingDevdoc;
  const skipArchitecture = hasConfirmedDevdoc || ['WAITING_DEVDOC_CONFIRM', 'PLANNING', 'EXECUTING', 'REVIEWING', 'FIXING', 'INTEGRATING', 'TESTING', 'WAITING_ACCEPTANCE'].includes(currentStatus);

  console.log(`[engine] 状态检查: skipArchitecture=${skipArchitecture}, hasConfirmedDevdoc=${hasConfirmedDevdoc}`);

  // ========== 阶段1: 架构（如果需要）==========
  if (!skipArchitecture) {
    transition(tc.taskId, 'ARCHITECTURE', { nodeId: 'clarify' }, deps.hub);
    for (let attempt = 0; attempt < 4; attempt++) {
    if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');
    const autoNote = task.auto_mode
      ? '\n\n【全自动模式】用户不会回答你的问题。请直接按合理默认假设（简单可用优先）产出开发文档并调用 report，不要提问。'
      : '';
    // 澄清问答与打回意见必须回灌，否则架构师看不到用户回答，会重复提问直到用尽 4 次尝试。
    const clarifySection = tc.clarifyTranscript.length
      ? `\n\n已有澄清与修订意见（请直接采纳，不要重复提问）：\n${tc.clarifyTranscript.join('\n')}`
      : '';
    const prompt = `本次任务目标：\n${task.objective}\n\n项目背景（历史记忆）：\n${projectMemory(tc.taskId)}${clarifySection}${autoNote}`;
    
    // 优化：增强架构阶段错误处理
    let run: { runId: string; report: string | null; output: string; ok: boolean };
    try {
      run = await executeRole(tc, 'architect', prompt, deps, 'clarify');
      saveContext(tc); // 每次关键步骤后保存
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine] 架构师执行异常（尝试 ${attempt + 1}/4）:`, errMsg);
      // 如果是最后一次尝试，则失败
      if (attempt === 3) {
        return finishTask(tc, deps, 'NEEDS_HUMAN', `架构师执行异常：${errMsg.slice(0, 500)}`);
      }
      // 否则等待 5 秒后重试
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    
    devdoc = registerDevdoc(tc);
    if (!devdoc) {
      // 架构师提问（无开发文档）：全自动模式自动按合理默认继续，否则等用户在网页回答
      if (task.auto_mode) {
        tc.clarifyTranscript.push('用户(全自动): 按合理默认假设继续');
        transition(tc.taskId, 'ARCHITECTURE', { nodeId: 'clarify', reason: '全自动模式：按默认继续' }, deps.hub);
        saveContext(tc);
        continue;
      }
      transition(tc.taskId, 'WAITING_CLARIFICATION', { nodeId: 'clarify', agentRunId: run.runId, reason: '架构师需要澄清需求' }, deps.hub);
      // 架构师的问题存入对话记录（网页聊天面板展示）
      const q = (run.output || '').slice(-3000);
      getDb().prepare('INSERT INTO messages (id, task_id, phase, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), tc.taskId, 'clarify', 'agent', q, Date.now());
      deps.hub.publish({ type: 'clarification.question', task_id: tc.taskId, content: q });
      saveContext(tc); // 等待用户输入前保存
      const answer = await waitGate(tc, 'clarify');
      if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');
      tc.clarifyTranscript.push(`用户: ${answer.comment ?? ''}`);
      transition(tc.taskId, 'ARCHITECTURE', { nodeId: 'clarify', reason: '收到澄清回答，继续' }, deps.hub);
      saveContext(tc);
      continue;
    }
    // 开发文档确认门（可打回修订；全自动模式自动通过）
    transition(tc.taskId, 'WAITING_DEVDOC_CONFIRM', { nodeId: 'devdoc_confirm', reason: `开发文档 v${devdoc.version}` }, deps.hub);
    deps.hub.publish({ type: 'devdoc.confirm.request', task_id: tc.taskId, version: devdoc.version });
    let docDecision: GateDecision;
    if (task.auto_mode) {
      docDecision = { decision: 'confirm', comment: '全自动模式：自动确认' };
    } else {
      saveContext(tc); // 等待确认前保存
      docDecision = await waitGate(tc, 'devdoc');
    }
    if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');
    if (docDecision.decision === 'confirm') {
      getDb().prepare("UPDATE devdocs SET status = 'confirmed', confirmed_at = ? WHERE task_id = ? AND version = ?").run(Date.now(), tc.taskId, devdoc.version);
      saveContext(tc);
      break;
    }
    tc.clarifyTranscript.push(`用户打回意见: ${docDecision.comment ?? ''}`);
    transition(tc.taskId, 'ARCHITECTURE', { nodeId: 'devdoc_confirm', reason: `开发文档被打回修订（v${devdoc.version} → v${devdoc.version + 1}）` }, deps.hub);
    saveContext(tc);
  }
  if (!devdoc) return finishTask(tc, deps, 'NEEDS_HUMAN', '架构师未产出开发文档');
  } // 结束 skipArchitecture 条件块
  else {
    // 跳过架构阶段：使用已有的confirmed devdoc
    // devdocs 表只存 content_path，正文必须从磁盘读回；早先直接读 .content
    // 会拿到 undefined，让后续所有角色都收到空开发文档。
    console.log(`[engine] 跳过架构阶段，使用已有开发文档 v${existingDevdoc.version}`);
    const docPath = existingDevdoc.content_path as string | undefined;
    const docBody = docPath && existsSync(docPath) ? readFileSync(docPath, 'utf-8').slice(0, 20000) : readDevdoc(tc);
    if (!docBody.trim()) {
      return finishTask(tc, deps, 'NEEDS_HUMAN', `已确认的开发文档 v${existingDevdoc.version} 内容缺失（${docPath ?? '路径未记录'}），无法继续`);
    }
    devdoc = { version: existingDevdoc.version, content: docBody };
    // 续跑时对齐版本号，避免修订时又从 v1 开始撞已有版本
    if (tc.devdocVersion < existingDevdoc.version) tc.devdocVersion = existingDevdoc.version;
  }

  // 3. 计划：主调度读取开发文档，产出 plan.json（模块拆解）
  // 断点续传：如果已有plan.json，跳过计划Agent但保留状态流转
  const hasPlan = existsSync(path.join(tc.repo, 'plan.json'));
  transition(tc.taskId, 'PLANNING', { nodeId: 'plan' }, deps.hub);
  if (!hasPlan) {
    const planPrompt = `请阅读 docs/devdoc.md，按你的职责在 plan.json 中输出模块拆解，然后调用 report 汇总。`;
    await executeRole(tc, 'lead', planPrompt, deps, 'plan');
    saveContext(tc); // 计划完成后保存
  } else {
    console.log(`[engine] 跳过计划Agent执行，plan.json 已存在`);
  }

  // 4. 执行（一主多从并行 / 单模块串行）→ 交付即查 → 整合 → QA → 验收
  transition(tc.taskId, 'EXECUTING', { nodeId: 'execute' }, deps.hub);
  let fixContext = '';
  let implSummary = '';
  for (;;) {
    if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');

    // 中途插话（开发文档 FR-10）：执行中新需求并入下一轮实现
    const interjects = getDb().prepare(
      "SELECT content, created_at FROM messages WHERE task_id = ? AND phase = 'interject' AND created_at > ? ORDER BY created_at ASC",
    ).all(tc.taskId, tc.interjectCursor) as any[];
    if (interjects.length > 0) {
      const texts = interjects.map((i: any) => i.content).join('；');
      fixContext = `${fixContext ? fixContext + '\n' : ''}用户中途新增要求（需在本次实现中满足）：${texts}`;
      tc.interjectCursor = interjects[interjects.length - 1].created_at;
      deps.hub.publish({ type: 'task.status', task_id: tc.taskId, status: 'EXECUTING', ts: Date.now() } as any);
      saveContext(tc); // 插话后保存
    }

    // —— 阶段 A：实现 + 交付即查（多模块并行 worktree；单模块主树串行）——
    const modules = readModules(tc.repo);
    let merged: boolean = true;
    let mergeDetail = '';
    if (modules.length > 1) {
      const result = await runModulesParallel(tc, deps, devdoc, modules, maxReview, fixContext);
      if (result.needHuman) return finishTask(tc, deps, 'NEEDS_HUMAN', result.reason ?? '并行执行异常');
      implSummary = result.summary;
      // —— 整合：合并各模块分支回主分支 ——
      transition(tc.taskId, 'INTEGRATING', { nodeId: 'integrate' }, deps.hub);
      const m = await integrateWorktrees(tc, deps, result.worktrees);
      merged = m.ok;
      mergeDetail = m.output;
      if (!merged) return finishTask(tc, deps, 'NEEDS_HUMAN', `整合冲突（请人工处理）：\n${mergeDetail.slice(0, 2000)}`);
    } else {
      // 单模块：主工作树内实现 + 审查返工循环
      for (;;) {
        if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');
        const implPrompt = `请严格依据开发文档 docs/devdoc.md 实现任务，完成后调用 report 汇总（summary 与 files_changed）。${fixContext ? `\n\n上次审查/质检/验收问题，请逐一修复：\n${fixContext}` : ''}`;
        const impl = await executeRoleWithRetry(tc, 'implementer', implPrompt, deps, 'execute');
        implSummary = impl.report ?? impl.output.slice(0, 500);
        commitWorkdir(tc.repo, 'task implementation');
        saveContext(tc); // 实现完成后保存
        transition(tc.taskId, 'REVIEWING', { nodeId: 'review' }, deps.hub);
        const review = await runReview(tc, deps, devdoc, impl.runId);
        if (review.verdict === 'FAIL') {
          tc.reviewIter++;
          saveContext(tc); // 审查失败后保存
          if (tc.reviewIter > maxReview) return finishTask(tc, deps, 'NEEDS_HUMAN', `审查返工超过 ${maxReview} 次`);
          fixContext = `审查问题：${review.issues}`;
          transition(tc.taskId, 'FIXING', { nodeId: 'review', reason: `第 ${tc.reviewIter} 次返工` }, deps.hub);
          continue;
        }
        saveContext(tc); // 审查通过后保存
        break;
      }
      transition(tc.taskId, 'INTEGRATING', { nodeId: 'integrate', reason: '单模块串行，无需合并' }, deps.hub);
    }

    // —— 阶段 B：QA + 验收门 ——
    transition(tc.taskId, 'TESTING', { nodeId: 'qa' }, deps.hub);
    const qaPrompt = `请按开发文档 docs/devdoc.md 的"验收命令"章节执行构建与测试。

完成后必须调用 report 工具，summary 第一行必须是 \`VERDICT: PASS\` 或 \`VERDICT: FAIL\`，第二行起写执行了哪些命令、输出摘要与失败原因。`;
    const qa = await executeRole(tc, 'qa', qaPrompt, deps, 'qa');
    const qaVerdict = verdictOf(qa.report, qa.output, qa.ok);
    if (qaVerdict === 'FAIL') {
      tc.qaIter++;
      saveContext(tc); // QA 失败后保存
      if (tc.qaIter > maxReview) return finishTask(tc, deps, 'NEEDS_HUMAN', `QA 返工超过 ${maxReview} 次`);
      fixContext = `质检问题：${(qa.report ?? qa.output).slice(0, 3000)}`;
      transition(tc.taskId, 'FIXING', { nodeId: 'qa', agentRunId: qa.runId, reason: `QA 第 ${tc.qaIter} 次返工` }, deps.hub);
      continue;
    }
    saveContext(tc); // QA 通过后保存

    // 用户验收门（QA 通过后自动尝试启动网页预览）
    if (merged) {
      const preview = await startPreview(tc.repo).catch(() => ({ ok: false as const, error: '预览启动异常' }));
      if (preview.ok && preview.url) {
        recordDelivery(tc.taskId, 'preview', preview.url, preview.port, preview.pid);
        deps.hub.publish({ type: 'preview.ready', task_id: tc.taskId, url: preview.url });
      }
    }
    transition(tc.taskId, 'WAITING_ACCEPTANCE', { nodeId: 'acceptance' }, deps.hub);
    deps.hub.publish({ type: 'acceptance.request', task_id: tc.taskId, summary: `实现摘要：${implSummary.slice(0, 500)}` });
    let accept: GateDecision;
    if (task.auto_mode) {
      accept = { decision: 'accept', comment: '全自动模式：自动验收' };
    } else {
      saveContext(tc); // 等待验收前保存
      accept = await waitGate(tc, 'acceptance');
    }
    if (tc.cancelled) return finishTask(tc, deps, 'CANCELLED', '用户取消');
    if (accept.decision === 'accept') {
      return finishTask(tc, deps, 'COMPLETED', `用户验收通过。${implSummary.slice(0, 300)}`);
    }
    tc.acceptIter++;
    saveContext(tc); // 验收打回后保存
    if (tc.acceptIter > 3) return finishTask(tc, deps, 'NEEDS_HUMAN', '验收打回超过 3 次');
    fixContext = `用户验收意见：${accept.comment ?? '请按用户意见修改'}`;
    transition(tc.taskId, 'FIXING', { nodeId: 'acceptance', reason: `验收打回（第 ${tc.acceptIter} 次）` }, deps.hub);
  }
}

/* ========== 并行执行（一主多从 + Worktree + 交付即查） ========== */

interface ModuleSpec {
  id: string;
  name?: string;
  description?: string;
  file_scope?: string[];
  acceptance?: string[];
  depends_on?: string[];
}

function readModules(repo: string): ModuleSpec[] {
  const p = path.join(repo, 'plan.json');
  if (!existsSync(p)) return [{ id: 'core', name: '核心实现', description: '按开发文档实现' }];
  try {
    const plan = JSON.parse(readFileSync(p, 'utf-8'));
    if (Array.isArray(plan.modules) && plan.modules.length > 0) {
      return plan.modules;
    }
  } catch { /* 忽略，用默认 */ }
  return [{ id: 'core', name: '核心实现', description: '按开发文档实现' }];
}

function git(repo: string, args: string[]): { ok: boolean; output: string } {
  const r = execSync2('git', args, repo);
  return { ok: r.ok, output: r.output };
}

function execSync2(cmd: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 120000 });
  return { ok: r.status === 0, output: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

/** 确保主分支有初始提交（worktree 需要 HEAD） */
function ensureInitialCommit(repo: string): void {
  if (git(repo, ['rev-parse', '--verify', 'HEAD']).ok) return;
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init: devdoc & plan']);
}

async function runModulesParallel(
  tc: TaskContext,
  deps: EngineDeps,
  devdoc: { version: number; content: string },
  modules: ModuleSpec[],
  maxReview: number,
  fixContext: string,
): Promise<{ ok: boolean; needHuman: boolean; reason?: string; summary: string; worktrees: { module: string; branch: string; path: string }[] }> {
  const db = getDb();
  ensureInitialCommit(tc.repo);
  const worktrees: { module: string; branch: string; path: string }[] = [];
  const summaries: string[] = [];

  for (const m of modules) {
    const branch = `task/${tc.taskId}/${m.id}`;
    const wtPath = path.join(tc.repo, '.worktrees', m.id);

    // 重跑/续跑时上一轮的 worktree 和分支往往还在，`worktree add -b` 必然失败。
    // 之前只检查路径是否在 worktree list 里就当"复用成功"，结果模块在残留的旧
    // 工作树里执行，实现和审查都对着上一轮的代码，任务无法跑完。这里显式先清理
    // 再重建，确保每轮都是干净的分支起点。
    if (git(tc.repo, ['worktree', 'list']).output.includes(wtPath)) {
      git(tc.repo, ['worktree', 'remove', '--force', wtPath]);
    }
    git(tc.repo, ['worktree', 'prune']);
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });

    let g = git(tc.repo, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    if (!g.ok) {
      // 分支已存在（上一轮遗留）：复位到当前 HEAD 后再挂载
      git(tc.repo, ['branch', '-f', branch, 'HEAD']);
      g = git(tc.repo, ['worktree', 'add', wtPath, branch]);
    }
    if (!g.ok) {
      return { ok: false, needHuman: true, reason: `创建 Worktree 失败: ${g.output.slice(0, 500)}`, summary: '', worktrees };
    }
    worktrees.push({ module: m.id, branch, path: wtPath });
    db.prepare(
      "INSERT INTO subtasks (id, task_id, devdoc_version, module, description, file_scope, acceptance, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')",
    ).run(crypto.randomUUID(), tc.taskId, devdoc.version, m.id, m.description ?? m.name ?? '', JSON.stringify(m.file_scope ?? []), JSON.stringify(m.acceptance ?? []));
  }

  // 主调度下发模块实现指令（执行者工作单）
  const briefs = await leadGenerateBriefs(tc, deps, modules);

  // 并行执行（受执行者上限约束，分批）
  const cap = Number((getDb().prepare("SELECT value FROM settings WHERE key='executor_cap'").get() as any)?.value ?? 2);
  for (let i = 0; i < worktrees.length; i += cap) {
    const batch = worktrees.slice(i, i + cap);
    const results = await Promise.all(
      batch.map((wt) =>
        runModuleWithReview(tc, deps, devdoc, wt.module, wt.path, maxReview, fixContext, briefs[wt.module]).catch((err) => ({
          ok: false as const,
          needHuman: true,
          summary: `模块异常: ${err instanceof Error ? err.message : String(err)}`,
        })),
      ),
    );
    for (const r of results) {
      if (!r.ok) {
        return { ok: false, needHuman: (r as any).needHuman !== false, reason: r.summary, summary: '', worktrees };
      }
      summaries.push(r.summary);
    }
  }

  return { ok: true, needHuman: false, summary: summaries.join('\n'), worktrees };
}

/** 单个模块：实现 → 交付即查（审查）⇄ 返工；失败/审查不过时由主调度实时监督决策 */
async function runModuleWithReview(
  tc: TaskContext,
  deps: EngineDeps,
  devdoc: { version: number; content: string },
  moduleId: string,
  workdir: string,
  maxReview: number,
  fixContext: string,
  brief?: { brief: string; files: string[]; notes: string },
): Promise<{ ok: boolean; summary: string; needHuman?: boolean }> {
  const db = getDb();
  let ctx = fixContext;
  let lastImplRunId = '';
  let agentOverride: string | undefined;
  let moduleReviewIter = 0;

  for (let i = 0; i <= maxReview + 2; i++) {
    if (tc.cancelled) return { ok: false, summary: '用户取消' };

    const briefNote = brief ? `\n\n【主调度指令】${brief.brief}${brief.files?.length ? `\n涉及文件：${brief.files.join(', ')}` : ''}${brief.notes ? `\n注意事项：${brief.notes}` : ''}` : '';
    const implPrompt = `你负责模块 ${moduleId}。请严格依据开发文档 docs/devdoc.md 与计划 plan.json 实现本模块，完成后调用 report 汇总（summary 与 files_changed）。${briefNote}${ctx ? `\n\n上次审查/质检问题，请逐一修复：\n${ctx}` : ''}`;
    const impl = await executeRoleWithRetry(tc, 'implementer', implPrompt, deps, 'execute', workdir, agentOverride);

    if (!impl.ok) {
      // 执行者失败（重试耗尽）→ 主调度实时监督决策
      const decision = await decideByLead(tc, deps, `模块 ${moduleId} 执行失败：${impl.output.slice(0, 800)}`);
      if (decision.action === 'reassign') {
        const others = db.prepare("SELECT id FROM agents WHERE role_id = 'role-implementer' ORDER BY created_at DESC").all() as any[];
        agentOverride = others.find((a: any) => a.id !== agentOverride)?.id;
        ctx = `主调度决策：更换执行者。原因：${decision.reason}`;
        continue;
      }
      if (decision.action === 'simplify') {
        ctx = `主调度决策：请简化实现后重试。原因：${decision.reason}`;
        continue;
      }
      if (decision.action === 'skip') {
        return { ok: true, summary: `模块 ${moduleId} 由主调度决策跳过：${decision.reason}` };
      }
      if (decision.action === 'need_human') {
        return { ok: false, needHuman: true, summary: `模块 ${moduleId} 主调度判定需人工介入：${decision.reason}` };
      }
      ctx = `主调度决策：重试。原因：${decision.reason || impl.output.slice(0, 300)}`;
      continue;
    }

    lastImplRunId = impl.runId;
    commitWorkdir(workdir, `module ${moduleId} implementation`);
    const review = await runReview(tc, deps, devdoc, impl.runId, workdir, moduleReviewIter + 1);
    if (review.verdict === 'FAIL') {
      // 审查不过 → 直接退回该执行者修改，直到审查通过。
      // 计数与问题文本按模块独立，避免并行模块互相消耗返工配额、互相覆盖问题描述。
      moduleReviewIter++;
      if (moduleReviewIter > maxReview) {
        return { ok: false, needHuman: true, summary: `模块 ${moduleId} 审查返工超过 ${maxReview} 次，需人工介入` };
      }
      ctx = `审查问题：${review.issues}`;
      continue;
    }
    return { ok: true, summary: `模块 ${moduleId}: ${(impl.report ?? impl.output).slice(0, 300)}` };
  }
  return { ok: false, summary: `模块 ${moduleId} 未通过审查` };
}

/** 执行角色并自动重试（中转临时错误容错，如 503/限流） */
async function executeRoleWithRetry(
  tc: TaskContext,
  role: string,
  context: string,
  deps: EngineDeps,
  nodeId: string,
  workdir?: string,
  agentId?: string,
  retries = 3,
): Promise<{ runId: string; report: string | null; output: string; ok: boolean }> {
  for (let i = 0; i <= retries; i++) {
    const r = await executeRole(tc, role, context, deps, nodeId, workdir, agentId);
    if (r.ok || i === retries) return r;
    const delay = 10_000 * (i + 1);
    // eslint-disable-next-line no-console
    console.log(`[engine] ${role} 运行失败（${r.output.slice(0, 120)}），${delay / 1000}s 后重试 ${i + 1}/${retries}`);
    await new Promise((res) => setTimeout(res, delay));
  }
  return { runId: '', report: null, output: '重试耗尽', ok: false };
}

/**
 * 主调度执行监督：执行遇到问题（执行者失败/审查不过）时，由主调度自主决策如何解决。
 * 输出结构化决策：ACTION: retry|reassign|simplify|skip|need_human  REASON MESSAGE
 */
async function decideByLead(
  tc: TaskContext,
  deps: EngineDeps,
  situation: string,
  retries = 1,
): Promise<{ action: string; reason: string; message: string }> {
  const prompt = `当前任务执行遇到问题，请以主调度身份做出处置决策（你正在实时监督执行）。

问题情况：
${situation.slice(0, 4000)}

请输出决策，格式（必须包含 ACTION 与 REASON）：
ACTION: retry | reassign | simplify | skip | need_human
REASON: <一句话原因>
MESSAGE: <如需要给执行者的指示，否则留空>

其中：
- retry：让执行者重试
- reassign：换一个执行者（引擎会自动换）
- simplify：让执行者简化实现后重试
- skip：接受现状，跳过该模块继续
- need_human：无法自行解决，需要用户介入`;
  const run = await executeRoleWithRetry(tc, 'lead', prompt, deps, 'plan', tc.repo, undefined, retries);
  const out = (run.report ?? run.output) ?? '';
  const action = (out.match(/ACTION:\s*(\w+)/i)?.[1] ?? 'retry').toLowerCase();
  const reason = (out.match(/REASON:\s*([^\n]*)/i)?.[1] ?? '').trim();
  const message = (out.match(/MESSAGE:\s*([^\n]*)/i)?.[1] ?? '').trim();
  if (!['retry', 'reassign', 'simplify', 'skip', 'need_human'].includes(action)) {
    return { action: 'retry', reason: '决策解析失败，默认重试', message: '' };
  }
  return { action, reason, message };
}

/** 主调度为各模块下发详细实现指令（执行者按指令实现，主调度主导执行） */
async function leadGenerateBriefs(
  tc: TaskContext,
  deps: EngineDeps,
  modules: ModuleSpec[],
): Promise<Record<string, { brief: string; files: string[]; notes: string }>> {
  const prompt = `你正在主导执行：请为以下每个模块生成详细实现指令，作为执行者的工作单。

模块清单：
${JSON.stringify(modules, null, 2)}

请输出 JSON（键为模块 id，值为对象）：
{"M1": {"brief": "本模块要做什么、怎么做、核心逻辑", "files": ["涉及的文件相对路径"], "notes": "注意事项/依赖"} , ...}

只输出 JSON，不要其他文字。`;
  const run = await executeRoleWithRetry(tc, 'lead', prompt, deps, 'plan', tc.repo, undefined, 1);
  const out = (run.report ?? run.output) ?? '';
  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (typeof parsed === 'object') return parsed;
    } catch { /* 解析失败回退空 */ }
  }
  return {};
}

/**
 * 解析审查基线：返回可复现本次改动的 diff 命令参数。
 *
 * 单模块模式在主工作树上直接提交，`main...HEAD` 恒为空（HEAD 就是 main），
 * 审查者因此看不到任何改动而一律判 FAIL。这里按工作树的真实位置选基线：
 * - 在 task/* 模块分支上：main...HEAD（分支相对主干的全部改动）
 * - 在主分支上：HEAD~1..HEAD（本轮实现提交）
 */
function resolveDiffRange(workdir: string): string {
  const branch = execSync2('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workdir).output.trim();
  const onMain = branch === 'main' || branch === 'master' || branch === 'HEAD';
  if (!onMain && git(workdir, ['rev-parse', '--verify', 'main']).ok) {
    return 'main...HEAD';
  }
  // 主分支：用上一个提交作基线；只有一个提交时退化为空树对比
  if (execSync2('git', ['rev-parse', '--verify', 'HEAD~1'], workdir).ok) {
    return 'HEAD~1..HEAD';
  }
  const empty = execSync2('git', ['hash-object', '-t', 'tree', '/dev/null'], workdir).output.trim();
  return empty ? `${empty}..HEAD` : 'HEAD';
}

/** 统计 git diff 复杂度（文件数、增减行数），用于审查分层 */
function diffStats(workdir: string, range: string): { files: number; lines: number } {
  const r = execSync2('git', ['diff', range, '--stat'], workdir);
  const out = r.output;
  const fileMatches = out.match(/files? changed/i);
  const files = fileMatches ? Number((out.match(/(\d+)\s+files? changed/i) ?? [])[1] ?? 0) : 0;
  let lines = 0;
  const lineMatch = out.match(/(\d+)\s+insertions?/i);
  const delMatch = out.match(/(\d+)\s+deletions?/i);
  if (lineMatch) lines += Number(lineMatch[1]);
  if (delMatch) lines += Number(delMatch[1]);
  return { files, lines };
}

/** 审查分层：按复杂度选 reviewer_high / reviewer_low（预设/任务覆盖中配置） */
function resolveReviewerAgent(tc: TaskContext, useHigh: boolean): any {
  const db = getDb();
  const task = db.prepare('SELECT preset_id, agent_overrides FROM tasks WHERE id = ?').get(tc.taskId) as any;
  const pick = (key: string): any => {
    if (task?.agent_overrides) {
      const ov = JSON.parse(task.agent_overrides || '{}');
      const aid = ov[key];
      if (aid) return db.prepare('SELECT * FROM agents WHERE id = ?').get(aid) as any;
    }
    if (task?.preset_id) {
      const preset = db.prepare('SELECT role_agent_map FROM presets WHERE id = ?').get(task.preset_id) as any;
      if (preset) {
        const map = JSON.parse(preset.role_agent_map || '{}');
        const aid = map[key];
        if (aid) return db.prepare('SELECT * FROM agents WHERE id = ?').get(aid) as any;
      }
    }
    return null;
  };
  return (useHigh ? pick('reviewer_high') : pick('reviewer_low')) ?? pick('reviewer_high') ?? pick('reviewer_low') ?? resolveAgent(tc, 'reviewer');
}

/** 审查一次（记录 reviews 表；结果存 tc.lastReviewIssues；支持分层审查） */
async function runReview(
  tc: TaskContext,
  deps: EngineDeps,
  devdoc: { version: number; content: string },
  targetRunId: string,
  workdir?: string,
  iteration?: number,
): Promise<{ verdict: 'PASS' | 'FAIL'; issues: string }> {
  const db = getDb();
  // 审查分层：按变更复杂度选择高质量(Pro)/低质量(Flash)审查 Agent
  const reviewDir = workdir ?? tc.repo;
  const range = resolveDiffRange(reviewDir);
  const stats = diffStats(reviewDir, range);
  const useHigh = stats.files >= 5 || stats.lines >= 300;
  const reviewerAgent = resolveReviewerAgent(tc, useHigh);

  transition(tc.taskId, 'REVIEWING', { nodeId: 'review', agentRunId: targetRunId }, deps.hub);
  const reviewPrompt = `（${useHigh ? '高质量审查' : '常规审查'}）请对照开发文档 docs/devdoc.md 审查当前实现。

查看本次改动请使用（基线已由引擎确定，请照用）：
  git diff ${range} --stat
  git diff ${range}

本次改动规模：${stats.files} 个文件，${stats.lines} 行增删。

审查后必须调用 report 工具，summary 第一行必须是 \`VERDICT: PASS\` 或 \`VERDICT: FAIL\`，第二行起列出具体问题。`;
  const review = await executeRole(tc, 'reviewer', reviewPrompt, deps, 'review', workdir, reviewerAgent?.id);
  const verdict = verdictOf(review.report, review.output, review.ok);
  const issues = (review.report ?? review.output ?? '').slice(0, 3000);
  // 并行模块各自持有返工计数与问题文本，这里只回填单模块串行路径使用的字段
  tc.lastReviewIssues = issues;
  db.prepare(
    'INSERT INTO reviews (id, task_id, reviewer_run_id, target_agent_run_id, verdict, issues, iteration) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), tc.taskId, review.runId, targetRunId, verdict, JSON.stringify([{ tier: useHigh ? 'high' : 'low', stats, range }]), iteration ?? tc.reviewIter + 1);
  return { verdict, issues };
}

/** 整合：合并各模块分支回主分支，然后清理 Worktree */
async function integrateWorktrees(
  tc: TaskContext,
  deps: EngineDeps,
  worktrees: { module: string; branch: string; path: string }[],
): Promise<{ ok: boolean; output: string }> {
  for (const wt of worktrees) {
    const m = git(tc.repo, ['merge', '--no-ff', wt.branch, '-m', `merge module ${wt.module}`]);
    if (!m.ok) {
      // 清理已创建的 worktree
      for (const w of worktrees) git(tc.repo, ['worktree', 'remove', '--force', w.path]);
      return { ok: false, output: `合并 ${wt.module} 冲突:\n${m.output.slice(0, 1500)}` };
    }
  }
  for (const wt of worktrees) git(tc.repo, ['worktree', 'remove', '--force', wt.path]);
  return { ok: true, output: '整合完成' };
}

function projectMemory(taskId: string): string {
  const db = getDb();
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) return '';
  const rows = db.prepare('SELECT kind, content FROM project_memories WHERE project_id = ? ORDER BY created_at DESC LIMIT 5').all(task.project_id) as any[];
  return rows.map((r: any) => `[${r.kind}] ${r.content}`).join('\n');
}

/** 服务重启恢复：把运行中任务标记为中断 */
/** 服务重启恢复：把运行中任务标记为中断（只在服务启动时调用一次） */
let bootRecovered = false;
export function recoverOnBoot(): void {
  if (bootRecovered) return; // 防止重复调用
  bootRecovered = true;
  
  const db = getDb();
  // 优化：只标记真正在运行中的任务（有 RUNNING 状态的 agent_run）
  const rows = db.prepare(`
    SELECT DISTINCT t.id, t.status 
    FROM tasks t
    JOIN agent_runs a ON a.task_id = t.id
    WHERE t.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    AND a.status = 'RUNNING'
  `).all(...ACTIVE_STATUSES) as any[];
  
  for (const r of rows) {
    console.log(`[engine] 恢复启动：任务 ${r.id} 状态 ${r.status} 有运行中的 Agent，标记为 NEEDS_HUMAN`);
    db.prepare("UPDATE tasks SET status = 'NEEDS_HUMAN' WHERE id = ?").run(r.id);
    db.prepare(
      "INSERT INTO task_transitions (id, task_id, from_status, to_status, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), r.id, r.status, 'NEEDS_HUMAN', '服务重启，任务中断（可重跑）', Date.now());
  }
  
  if (rows.length === 0) {
    console.log('[engine] 恢复启动：没有需要恢复的任务');
  }
}

/** 供 index.ts 注入依赖 */
export function initEngine(secrets: SecretStore, hub: WsHub): void {
  (globalThis as any).__workbenchSecrets = secrets;
  (globalThis as any).__workbenchHub = hub;
}
