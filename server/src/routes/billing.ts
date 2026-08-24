import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { SecretStore } from '../secrets/store.js';

/**
 * 中转账户真实用量（开发文档 §17 / FR-25）
 * 通过 OpenAI 风格 /dashboard/billing/usage 接口获取账户累计用量（美分，÷100 为美元）。
 * 任务级真实费用 = 完成后差值。
 */
const cache = new Map<string, { ts: number; value: number }>();
const CACHE_MS = 60_000;

async function fetchTotalUsage(baseUrl: string, apiKey: string): Promise<number | null> {
  const cacheKey = `${baseUrl}|${apiKey.slice(0, 12)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.value;
  const url = `${baseUrl.replace(/\/+$/, '')}/dashboard/billing/usage?start_date=${daysAgo(30)}&end_date=${today()}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const d: any = await res.json();
    const v = typeof d?.total_usage === 'number' ? d.total_usage : null;
    if (v !== null) cache.set(cacheKey, { ts: Date.now(), value: v });
    return v;
  } catch {
    return null;
  }
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerBillingRoutes(app: FastifyInstance, secrets: SecretStore): void {
  const db = getDb();

  // 各中转账户真实用量（近 30 天累计，美分）
  app.get('/api/billing/usage', async () => {
    const rows: any[] = [];
    const providers = db.prepare('SELECT * FROM providers WHERE enabled = 1').all() as any[];
    for (const p of providers) {
      // 该中转的所有密钥（含默认）
      const keys = db.prepare('SELECT * FROM provider_keys WHERE provider_id = ?').all(p.id) as any[];
      const entries = keys.length > 0
        ? keys.map((k) => ({ name: k.name, secret_ref: k.secret_ref }))
        : [{ name: '默认', secret_ref: p.secret_ref }];
      for (const e of entries) {
        const apiKey = secrets.get(e.secret_ref);
        if (!apiKey) continue;
        const usage = await fetchTotalUsage(p.base_url, apiKey);
        if (usage !== null) {
          rows.push({ provider: p.name.trim(), key: e.name, total_usage_cent: usage, usd: usage / 100 });
        } else {
          rows.push({ provider: p.name.trim(), key: e.name, total_usage_cent: null, usd: null, unsupported: true });
        }
      }
    }
    return { accounts: rows, fetched_at: Date.now(), unit: 'cent（÷100=USD）' };
  });

  // 单个密钥的账户用量（任务级快照用）
  app.get('/api/providers/:id/keys/:keyId/billing-usage', async (req) => {
    const { id, keyId } = req.params as any;
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    const key = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as any;
    if (!provider || !key) return { total_usage_cent: null };
    const apiKey = secrets.get(key.secret_ref);
    if (!apiKey) return { total_usage_cent: null };
    const v = await fetchTotalUsage(provider.base_url, apiKey);
    return { total_usage_cent: v, usd: v !== null ? v / 100 : null };
  });

  // Provider 默认密钥的账户用量
  app.get('/api/providers/:id/billing-usage', async (req) => {
    const { id } = req.params as any;
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!provider) return { total_usage_cent: null };
    const apiKey = secrets.get(provider.secret_ref);
    if (!apiKey) return { total_usage_cent: null };
    const v = await fetchTotalUsage(provider.base_url, apiKey);
    return { total_usage_cent: v, usd: v !== null ? v / 100 : null };
  });
}
