import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

const SETTING_KEYS = [
  'executor_cap',
  'max_concurrent_tasks',
  'review_max_iterations',
  'approval_policy',
  'preview_port_range',
  'auth_required',
];

export function registerSettingsRoutes(app: FastifyInstance): void {
  const db = getDb();

  app.get('/api/settings', async () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      if (SETTING_KEYS.includes(r.key)) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
      }
    }
    return out;
  });

  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of SETTING_KEYS) {
      if (body[key] !== undefined) {
        const val = typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]);
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, val);
      }
    }
    return { ok: true };
  });
}
