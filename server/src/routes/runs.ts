import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getDb } from '../db/index.js';
import { SecretStore } from '../secrets/store.js';
import { runApiAgent, resolveApiRun } from '../runtimes/api/loop.js';
import { recordAudit } from '../observability/audit.js';

/**
 * 单 Agent 触发接口（P0 验收用：手动触发一个 API Agent 完成小任务）
 * POST /api/runs  { agent_id, input, workdir }
 * GET  /api/runs/:id  返回日志与用量
 */
export function registerRunRoutes(app: FastifyInstance, secrets: SecretStore): void {
  const db = getDb();

  app.post('/api/runs', async (req, reply) => {
    const { agent_id, input, workdir, max_steps } = (req.body ?? {}) as {
      agent_id: string;
      input: string;
      workdir?: string;
      max_steps?: number;
    };
    if (!agent_id || !input) return reply.code(400).send({ error: 'invalid_input', message: 'agent_id 与 input 必填' });

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id) as any;
    if (!agent) return reply.code(404).send({ error: 'not_found', message: 'Agent 不存在' });

    const targetDir = workdir || path.join(DATA_DIR, 'sandbox');
    mkdirSync(targetDir, { recursive: true });

    try {
      const runReq = resolveApiRun(db, agent, secrets, input, targetDir);
      runReq.maxSteps = max_steps ?? 100; // 增加到100以支持复杂审查任务
      const started = Date.now();
      const result = await runApiAgent(runReq);
      const duration = Date.now() - started;

      // 用量入库（开发文档 §9.9）
      const route = db.prepare('SELECT id FROM billing_routes WHERE provider_id = ?').get(agent.provider_id) as any;
      db.prepare(
        `INSERT INTO usage_records (id, task_id, agent_run_id, billing_route_id, requests, prompt_tokens, completion_tokens, cached_tokens, duration_ms, cost_est, currency, available, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'USD', 1, ?)`,
      ).run(
        crypto.randomUUID(), 'manual', result.run_id, route?.id ?? 'manual',
        result.usage.requests, result.usage.prompt_tokens, result.usage.completion_tokens,
        duration, `manual-run:${result.status}`,
      );

      recordAudit(db, 'user', 'run:api', result.run_id, { agent_id, status: result.status });
      return { run_id: result.run_id, status: result.status, report: result.report, usage: result.usage };
    } catch (err) {
      return reply.code(400).send({ error: 'run_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const id = (req.params as any).id;
    try {
      const log = readFileSync(path.join(DATA_DIR, 'runs', `${id}.log`), 'utf-8');
      const usage = db.prepare('SELECT * FROM usage_records WHERE agent_run_id = ?').get(id);
      return { run_id: id, log, usage };
    } catch {
      return reply.code(404).send({ error: 'not_found', message: '未找到该次运行' });
    }
  });
}
