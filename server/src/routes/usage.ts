import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { estimateCost } from '../providers/pricing.js';

/** 用量与费用聚合（开发文档 §9.9 / FR-25） */
export function registerUsageRoutes(app: FastifyInstance): void {
  const db = getDb();

  const rowCost = (r: any): number =>
    estimateCost(r.model ?? '', r.prompt_tokens ?? 0, r.completion_tokens ?? 0);

  app.get('/api/usage', async (req) => {
    const q = req.query as { task_id?: string };
    const where = q.task_id ? 'WHERE u.task_id = ?' : '';
    const params: unknown[] = q.task_id ? [q.task_id] : [];

    // 逐条用量（带模型，用于精确计费）
    const rows = db.prepare(
      `SELECT u.id, u.task_id, u.agent_run_id, u.billing_route_id, u.requests, u.prompt_tokens, u.completion_tokens,
              u.cached_tokens, u.duration_ms, u.cost_est AS stored_cost, u.available, u.note,
              a.node_id AS stage, g.name AS agent_name, ag.model_id AS model
       FROM usage_records u
       LEFT JOIN agent_runs a ON a.id = u.agent_run_id
       LEFT JOIN agents g ON g.id = a.agent_id
       LEFT JOIN agents ag ON ag.id = a.agent_id
       ${where} ORDER BY u.id DESC LIMIT 500`,
    ).all(...params) as any[];

    const total = {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      cost_est: 0,
      currency: 'USD',
      duration_ms: 0,
    };
    for (const r of rows) {
      total.requests += r.requests ?? 0;
      total.prompt_tokens += r.prompt_tokens ?? 0;
      total.completion_tokens += r.completion_tokens ?? 0;
      total.cached_tokens += r.cached_tokens ?? 0;
      total.duration_ms += r.duration_ms ?? 0;
      // 订阅线路（available=0）不估算费用；API 线路按价格表估算
      if (r.available !== 0 && !/subscription/i.test(r.note ?? '')) {
        total.cost_est += rowCost(r);
      }
    }
    total.total_tokens = total.prompt_tokens + total.completion_tokens;

    // 按阶段（Agent 运行）分组
    const stageMap = new Map<string, any>();
    for (const r of rows) {
      const stage = r.stage ?? 'manual';
      const cur = stageMap.get(stage) ?? {
        stage,
        requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_est: 0, model: r.model ?? '',
      };
      cur.requests += r.requests ?? 0;
      cur.prompt_tokens += r.prompt_tokens ?? 0;
      cur.completion_tokens += r.completion_tokens ?? 0;
      if (r.available !== 0 && !/subscription/i.test(r.note ?? '')) cur.cost_est += rowCost(r);
      stageMap.set(stage, cur);
    }
    const byStage = [...stageMap.values()];

    return { total, byStage, detail: rows.map((r) => ({ ...r, cost_est: r.available !== 0 ? rowCost(r) : 0 })) };
  });

  app.get('/api/usage/summary', async () => {
    const rows = db.prepare(
      `SELECT u.prompt_tokens, u.completion_tokens, u.available, u.note, ag.model_id AS model
       FROM usage_records u LEFT JOIN agent_runs a ON a.id = u.agent_run_id
       LEFT JOIN agents ag ON ag.id = a.agent_id`,
    ).all() as any[];
    const total = { requests: rows.length, prompt_tokens: 0, completion_tokens: 0, cost_est: 0 };
    for (const r of rows) {
      total.prompt_tokens += r.prompt_tokens ?? 0;
      total.completion_tokens += r.completion_tokens ?? 0;
      if (r.available !== 0 && !/subscription/i.test(r.note ?? '')) total.cost_est += rowCost(r);
    }
    total.cost_est = Number(total.cost_est.toFixed(6));
    return total;
  });
}
