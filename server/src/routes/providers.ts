import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { SecretStore } from '../secrets/store.js';
import { testConnection } from '../providers/test-connection.js';
import { listModels } from '../providers/openai.js';

interface ProviderInput {
  name?: string;
  protocol?: string;
  base_url?: string;
  apiKey?: string;
  default_headers?: Record<string, string>;
  model_mapping?: Record<string, string>;
  timeout_ms?: number;
  max_retries?: number;
  rate_limit_hint?: string;
  enabled?: number;
}

function secretRefToName(secret_ref: string): string {
  return secret_ref.slice(0, 8);
}

export function registerProviderRoutes(app: FastifyInstance, secrets: SecretStore): void {
  const db = getDb();

  // 列表/单条：只暴露 secret_ref，绝不返回明文
  app.get('/api/providers', async () => {
    const rows = db.prepare('SELECT * FROM providers ORDER BY created_at DESC').all() as any[];
    return rows.map((r) => ({
      ...r,
      default_headers: safeJson(r.default_headers),
      model_mapping: safeJson(r.model_mapping),
      secret_ref: secretRefToName(r.secret_ref),
    }));
  });

  app.get('/api/providers/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get((req.params as any).id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return {
      ...row,
      default_headers: safeJson(row.default_headers),
      model_mapping: safeJson(row.model_mapping),
      secret_ref: secretRefToName(row.secret_ref),
    };
  });

  app.post('/api/providers', async (req, reply) => {
    const body = (req.body ?? {}) as ProviderInput;
    if (!body.name || !body.base_url) {
      return reply.code(400).send({ error: 'invalid_input', message: 'name 与 base_url 必填' });
    }
    const id = crypto.randomUUID();
    const secret_ref = secrets.create(`provider:${body.name}`, body.apiKey ?? '');
    db.prepare(
      `INSERT INTO providers (id, name, protocol, base_url, secret_ref, default_headers, model_mapping, timeout_ms, max_retries, rate_limit_hint, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, body.name, body.protocol ?? 'openai', body.base_url, secret_ref,
      JSON.stringify(body.default_headers ?? {}), JSON.stringify(body.model_mapping ?? {}),
      body.timeout_ms ?? 60000, body.max_retries ?? 2, body.rate_limit_hint ?? null,
      body.enabled ?? 1, Date.now(),
    );
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    return reply.code(201).send({ ...row, secret_ref: secretRefToName(row.secret_ref) });
  });

  app.put('/api/providers/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as ProviderInput;
    const cols: string[] = [];
    const vals: unknown[] = [];
    const set = (c: string, v: unknown) => { cols.push(`"${c}" = ?`); vals.push(v); };
    if (body.name !== undefined) set('name', body.name);
    if (body.protocol !== undefined) set('protocol', body.protocol);
    if (body.base_url !== undefined) set('base_url', body.base_url);
    if (body.default_headers !== undefined) set('default_headers', JSON.stringify(body.default_headers));
    if (body.model_mapping !== undefined) set('model_mapping', JSON.stringify(body.model_mapping));
    if (body.timeout_ms !== undefined) set('timeout_ms', body.timeout_ms);
    if (body.max_retries !== undefined) set('max_retries', body.max_retries);
    if (body.rate_limit_hint !== undefined) set('rate_limit_hint', body.rate_limit_hint);
    if (body.enabled !== undefined) set('enabled', body.enabled);
    if (body.apiKey) {
      // 更新密钥：新建 secret，旧引用保留（审计友好）
      const secret_ref = secrets.create(`provider:${body.name ?? existing.name}`, body.apiKey);
      set('secret_ref', secret_ref);
    }
    if (cols.length > 0) {
      db.prepare(`UPDATE providers SET ${cols.join(',')} WHERE id = ?`).run(...vals, id);
    }
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    return { ...row, secret_ref: secretRefToName(row.secret_ref) };
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    secrets.delete(row.secret_ref);
    return { ok: true };
  });

  // Test Connection（可诊断错误分级）
  app.post('/api/providers/:id/test-connection', async (req, reply) => {
    const id = (req.params as any).id;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const provider = {
      id: row.id, name: row.name, protocol: row.protocol, base_url: row.base_url,
      secret_ref: row.secret_ref, default_headers: safeJson(row.default_headers),
      model_mapping: safeJson(row.model_mapping), timeout_ms: row.timeout_ms,
      max_retries: row.max_retries, rate_limit_hint: row.rate_limit_hint,
      enabled: row.enabled, created_at: row.created_at,
    };
    if (provider.protocol !== 'openai') {
      return reply.code(400).send({ ok: false, message: '当前版本 Test Connection 支持 OpenAI 兼容协议；Anthropic 兼容适配将在后续版本提供' });
    }
    const result = await testConnection(provider, secrets);
    return result;
  });

  // 实时拉取该中转的可用模型列表（供前端勾选配置）
  app.get('/api/providers/:id/models', async (req, reply) => {
    const id = (req.params as any).id;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const apiKey = secrets.get(row.secret_ref);
    if (!apiKey) return reply.code(400).send({ error: 'no_secret', message: '请先为该 Provider 配置 API Key' });
    try {
      const models = await listModels(row.base_url, apiKey, 20_000);
      return { ok: models.length > 0, models, model_mapping: safeJson(row.model_mapping) };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err), message: '拉取模型列表失败' });
    }
  });
}

function safeJson(v: string | null | undefined): any {
  if (!v) return {};
  try { return JSON.parse(v); } catch { return {}; }
}

/* ========== Provider 多密钥（一个中转地址可配多个 Key，各自不同模型） ========== */

function providerOf(row: any): any {
  return {
    id: row.id, name: row.name, protocol: row.protocol, base_url: row.base_url,
    secret_ref: row.secret_ref, default_headers: safeJson(row.default_headers),
    model_mapping: safeJson(row.model_mapping), timeout_ms: row.timeout_ms,
    max_retries: row.max_retries, rate_limit_hint: row.rate_limit_hint,
    enabled: row.enabled, created_at: row.created_at,
  };
}

function keyOf(row: any): any {
  return {
    id: row.id, provider_id: row.provider_id, name: row.name,
    secret_ref: row.secret_ref.slice(0, 8), model_mapping: safeJson(row.model_mapping),
    enabled: row.enabled, created_at: row.created_at,
  };
}

export function registerProviderKeyRoutes(app: FastifyInstance, secrets: SecretStore): void {
  const db = getDb();

  app.get('/api/providers/:id/keys', async (req, reply) => {
    const rows = db.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY created_at ASC').all((req.params as any).id) as any[];
    return rows.map(keyOf);
  });

  app.post('/api/providers/:id/keys', async (req, reply) => {
    const providerId = (req.params as any).id;
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as any;
    if (!provider) return reply.code(404).send({ error: 'not_found' });
    const { name, apiKey } = (req.body ?? {}) as { name?: string; apiKey?: string };
    if (!name || !apiKey) return reply.code(400).send({ error: 'invalid_input', message: 'name 与 apiKey 必填' });
    const secretRef = secrets.create(`provider-key:${provider.name}/${name}`, apiKey);
    db.prepare('INSERT INTO provider_keys (id, provider_id, name, secret_ref, model_mapping, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(crypto.randomUUID(), providerId, name, secretRef, '{}', Date.now());
    return reply.code(201).send({ ok: true });
  });

  app.put('/api/providers/:id/keys/:keyId', async (req, reply) => {
    const { keyId } = req.params as any;
    const row = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { name?: string; apiKey?: string; model_mapping?: Record<string, string>; enabled?: number };
    if (body.name !== undefined) db.prepare('UPDATE provider_keys SET name = ? WHERE id = ?').run(body.name, keyId);
    if (body.enabled !== undefined) db.prepare('UPDATE provider_keys SET enabled = ? WHERE id = ?').run(body.enabled, keyId);
    if (body.model_mapping !== undefined) db.prepare('UPDATE provider_keys SET model_mapping = ? WHERE id = ?').run(JSON.stringify(body.model_mapping), keyId);
    if (body.apiKey) {
      const secretRef = secrets.create(`provider-key:${keyId}`, body.apiKey);
      db.prepare('UPDATE provider_keys SET secret_ref = ? WHERE id = ?').run(secretRef, keyId);
    }
    return { ok: true };
  });

  app.delete('/api/providers/:id/keys/:keyId', async (req, reply) => {
    const { keyId } = req.params as any;
    const row = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM provider_keys WHERE id = ?').run(keyId);
    secrets.delete(row.secret_ref);
    return { ok: true };
  });

  // 按密钥测试连接 / 拉模型
  app.post('/api/providers/:id/keys/:keyId/test-connection', async (req, reply) => {
    const { id, keyId } = req.params as any;
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    const key = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as any;
    if (!provider || !key) return reply.code(404).send({ error: 'not_found' });
    if (provider.protocol !== 'openai') return reply.code(400).send({ ok: false, message: '当前版本 Test Connection 支持 OpenAI 兼容协议' });
    const p = { ...providerOf(provider), secret_ref: key.secret_ref, model_mapping: safeJson(key.model_mapping) };
    const result = await testConnection(p, secrets);
    return result;
  });

  app.get('/api/providers/:id/keys/:keyId/models', async (req, reply) => {
    const { id, keyId } = req.params as any;
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    const key = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as any;
    if (!provider || !key) return reply.code(404).send({ error: 'not_found' });
    const apiKey = secrets.get(key.secret_ref);
    if (!apiKey) return reply.code(400).send({ error: 'no_secret', message: '该密钥未配置有效 API Key' });
    try {
      const models = await listModels(provider.base_url, apiKey, 20_000);
      return { ok: models.length > 0, models, model_mapping: safeJson(key.model_mapping) };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err), message: '拉取模型列表失败' });
    }
  });
}
