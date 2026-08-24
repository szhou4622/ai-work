import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

export interface CrudSpec {
  table: string;
  jsonCols?: string[];
  /** 供 PUT 合并时排除的列（如 id/created_at 由系统管理） */
  protectedCols?: string[];
}

function parseRow(r: any, jsonCols: string[]): any {
  if (!r) return null;
  const o: Record<string, unknown> = { ...r };
  for (const c of jsonCols) {
    if (o[c] != null && typeof o[c] === 'string') {
      try { o[c] = JSON.parse(o[c] as string); } catch { /* 保留原值 */ }
    }
  }
  return o;
}

function serializeBody(body: Record<string, unknown>, jsonCols: string[]): Record<string, unknown> {
  const x: Record<string, unknown> = { ...body };
  for (const c of jsonCols) {
    if (x[c] != null && typeof x[c] !== 'string') {
      x[c] = JSON.stringify(x[c]);
    }
  }
  return x;
}

/** 生成标准 CRUD 路由：GET/POST /api/:base，GET/PUT/DELETE /api/:base/:id */
export function registerCrud(app: FastifyInstance, base: string, spec: CrudSpec): void {
  const { table, jsonCols = [], protectedCols = ['id', 'created_at'] } = spec;
  const db = getDb();

  app.get(`/api/${base}`, async () => {
    return db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC`).all().map((r: any) => parseRow(r, jsonCols));
  });

  app.get(`/api/${base}/:id`, async (req, reply) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get((req.params as any).id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return parseRow(row, jsonCols);
  });

  app.post(`/api/${base}`, async (req, reply) => {
    const body = serializeBody((req.body ?? {}) as Record<string, unknown>, jsonCols);
    const id = randomUUID();
    const cols = ['id', ...Object.keys(body), 'created_at'];
    const vals = [id, ...Object.values(body), Date.now()];
    db.prepare(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).run(...vals);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return reply.code(201).send(parseRow(row, jsonCols));
  });

  app.put(`/api/${base}/:id`, async (req, reply) => {
    const id = (req.params as any).id;
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const body = serializeBody((req.body ?? {}) as Record<string, unknown>, jsonCols);
    const setCols = Object.keys(body).filter((c) => !protectedCols.includes(c));
    if (setCols.length === 0) return parseRow(existing, jsonCols);
    const setSql = setCols.map((c) => `"${c}" = ?`).join(',');
    const vals = [...setCols.map((c) => body[c]), id];
    db.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`).run(...vals);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return parseRow(row, jsonCols);
  });

  app.delete(`/api/${base}/:id`, async (req, reply) => {
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run((req.params as any).id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
