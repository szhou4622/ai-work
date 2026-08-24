import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { startTask, cancelTask, resumeGate } from '../orchestrator/engine.js';
import { recordAudit } from '../observability/audit.js';

/** 任务运行控制与人机门路由（开发文档 §8.1） */
export function registerTaskRoutes(app: FastifyInstance): void {
  const db = getDb();

  app.get('/api/tasks/:id/detail', async (req, reply) => {
    const id = (req.params as any).id;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) return reply.code(404).send({ error: 'not_found' });
    const transitions = db.prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY ts ASC').all(id);
    const runs = db.prepare(
      'SELECT a.*, g.name AS agent_name FROM agent_runs a LEFT JOIN agents g ON g.id = a.agent_id WHERE a.task_id = ? ORDER BY a.started_at ASC',
    ).all(id) as any[];
    
    // 优化：为每个 run 附加输出摘要（最后 2000 字符），解决 output/error 不可见问题
    const runsWithOutput = runs.map((run) => {
      let output = null;
      let error = null;
      if (run.output_path && existsSync(run.output_path)) {
        try {
          const full = readFileSync(run.output_path, 'utf-8');
          // 取最后 2000 字符作为摘要
          output = full.length > 2000 ? '...' + full.slice(-2000) : full;
          // 如果状态是 FAILED，尝试提取错误信息
          if (run.status === 'FAILED') {
            const errorMatch = full.match(/\[error\]([\s\S]{0,1000})/i);
            error = errorMatch ? errorMatch[1].trim() : '执行失败（详见完整日志）';
          }
        } catch (e) {
          // 读取失败，忽略
        }
      }
      return { ...run, output, error };
    });
    
    const reviews = db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY iteration ASC').all(id);
    const devdocs = db.prepare('SELECT * FROM devdocs WHERE task_id = ? ORDER BY version ASC').all(id);
    const messages = db.prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC').all(id);
    const subtasks = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').all(id);
    const handoffs = db.prepare(
      'SELECT h.*, a.node_id, a.agent_id, g.name AS agent_name FROM handoffs h JOIN agent_runs a ON a.id = h.agent_run_id LEFT JOIN agents g ON g.id = a.agent_id WHERE a.task_id = ? ORDER BY a.started_at ASC',
    ).all(id);
    const project = db.prepare('SELECT id, name, repo_path FROM projects WHERE id = ?').get((task as any).project_id);
    return { task, transitions, runs: runsWithOutput, reviews, devdocs, messages, subtasks, handoffs, project };
  });

  app.post('/api/tasks/:id/start', async (req, reply) => {
    const id = (req.params as any).id;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!task) return reply.code(404).send({ error: 'not_found' });
    if (!['CREATED', 'NEEDS_HUMAN'].includes(task.status)) {
      return reply.code(400).send({ error: 'invalid_state', message: `当前状态 ${task.status} 不允许启动` });
    }
    recordAudit(db, 'user', 'task:start', id, {});
    startTask(id).catch((err) => console.error('startTask failed', err));
    return { ok: true, message: '任务已启动' };
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const id = (req.params as any).id;
    const cancelled = cancelTask(id);
    if (!cancelled) {
      const info = db.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE id = ? AND status IN ('CREATED','QUEUED')").run(id);
      if (info.changes === 0) return reply.code(400).send({ error: 'invalid_state', message: '任务不在可取消状态' });
    }
    recordAudit(db, 'user', 'task:cancel', id, {});
    return { ok: true };
  });

  // 人机门：开发文档确认
  app.post('/api/tasks/:id/devdoc/confirm', async (req, reply) => {
    const id = (req.params as any).id;
    recordAudit(db, 'user', 'task:devdoc-confirm', id, {});
    const ok = resumeGate(id, 'devdoc', 'confirm');
    if (!ok) return reply.code(400).send({ error: 'invalid_state', message: '当前不在等待文档确认状态' });
    return { ok: true };
  });

  app.post('/api/tasks/:id/devdoc/reject', async (req, reply) => {
    const id = (req.params as any).id;
    const { comment } = (req.body ?? {}) as { comment?: string };
    recordAudit(db, 'user', 'task:devdoc-reject', id, { comment });
    const ok = resumeGate(id, 'devdoc', 'reject', comment);
    if (!ok) return reply.code(400).send({ error: 'invalid_state', message: '当前不在等待文档确认状态' });
    return { ok: true };
  });

  // 人机门：用户验收
  app.post('/api/tasks/:id/accept', async (req, reply) => {
    const id = (req.params as any).id;
    recordAudit(db, 'user', 'task:accept', id, {});
    const ok = resumeGate(id, 'acceptance', 'accept');
    if (!ok) return reply.code(400).send({ error: 'invalid_state', message: '当前不在等待验收状态' });
    return { ok: true };
  });

  app.post('/api/tasks/:id/reject-acceptance', async (req, reply) => {
    const id = (req.params as any).id;
    const { comment } = (req.body ?? {}) as { comment?: string };
    recordAudit(db, 'user', 'task:reject-acceptance', id, { comment });
    const ok = resumeGate(id, 'acceptance', 'reject', comment);
    if (!ok) return reply.code(400).send({ error: 'invalid_state', message: '当前不在等待验收状态' });
    return { ok: true };
  });

  // 澄清回答
  app.post('/api/tasks/:id/clarify-answer', async (req, reply) => {
    const id = (req.params as any).id;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content) return reply.code(400).send({ error: 'invalid_input', message: 'content 必填' });
    db.prepare('INSERT INTO messages (id, task_id, phase, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), id, 'clarify', 'user', content, Date.now());
    recordAudit(db, 'user', 'task:clarify-answer', id, {});
    const ok = resumeGate(id, 'clarify', 'answer', content);
    if (!ok) return reply.code(400).send({ error: 'invalid_state', message: '当前不在等待澄清状态' });
    return { ok: true };
  });

  // 中途插话（开发文档 FR-10）：执行中随时补充/修改需求；引擎在下一轮实现/返工时自动并入执行指令
  app.post('/api/tasks/:id/interject', async (req, reply) => {
    const id = (req.params as any).id;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content) return reply.code(400).send({ error: 'invalid_input', message: 'content 必填' });
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status?: string } | undefined;
    if (!task) return reply.code(404).send({ error: 'not_found' });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status ?? '')) {
      return reply.code(400).send({ error: 'invalid_state', message: '任务已结束，无法插话' });
    }
    const created_at = Date.now();
    db.prepare('INSERT INTO messages (id, task_id, phase, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), id, 'interject', 'user', content, created_at);
    recordAudit(db, 'user', 'task:interject', id, { content: content.slice(0, 200) });
    (globalThis as any).__workbenchHub?.publish({ type: 'task.interject', task_id: id, content, created_at });
    return { ok: true, created_at };
  });

  // 最新开发文档内容
  app.get('/api/tasks/:id/devdoc', async (req, reply) => {
    const id = (req.params as any).id;
    const row = db.prepare('SELECT * FROM devdocs WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found', message: '尚无开发文档' });
    const content = existsSync(row.content_path) ? readFileSync(row.content_path, 'utf-8') : '';
    return { version: row.version, status: row.status, content };
  });

  // Agent 运行日志查看（优化：解决 output/error 不可见问题）
  app.get('/api/agent-runs/:id/output', async (req, reply) => {
    const id = (req.params as any).id;
    const run = db.prepare('SELECT output_path, status FROM agent_runs WHERE id = ?').get(id) as any;
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Agent Run 不存在' });
    
    let output = '';
    if (run.output_path && existsSync(run.output_path)) {
      const full = readFileSync(run.output_path, 'utf-8');
      // 返回完整日志（前端可以按需截取）
      output = full;
    }
    
    return { 
      run_id: id, 
      status: run.status,
      output,
      has_log: !!run.output_path && existsSync(run.output_path)
    };
  });
}

/** 任务日志读取（供详情页） */
export function readRunLog(runId: string): string {
  const p = path.join(process.cwd(), 'data', 'runs', `${runId}.log`);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}
