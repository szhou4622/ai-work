import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/index.js';
import { ACCESS_PASSWORD, SESSION_TTL_MS } from '../config.js';

export const SESSION_COOKIE = 'workbench_session';

interface Session {
  token: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const ACCESS_PASSWORD_KEY = 'access_password_hash';

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(pw, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/** 首启初始化访问口令（开发文档 §11 ACCESS_PASSWORD） */
export function ensureAccessPassword(): void {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACCESS_PASSWORD_KEY) as { value: string } | undefined;
  if (row) return;
  const pw = ACCESS_PASSWORD || randomBytes(6).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ACCESS_PASSWORD_KEY, hashPassword(pw));
  if (!ACCESS_PASSWORD) {
    console.log(`\n[workbench] 首次启动：登录口令已生成（仅显示一次）: ${pw}\n`);
  } else {
    console.log('[workbench] 访问口令已从环境变量 ACCESS_PASSWORD 设置');
  }
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACCESS_PASSWORD_KEY) as { value: string } | undefined;
    if (!row || !password || !verifyPassword(password, row.value)) {
      return reply.code(401).send({ error: 'invalid_credentials', message: '口令错误' });
    }
    const token = randomUUID();
    sessions.set(token, { token, expiresAt: Date.now() + SESSION_TTL_MS });
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS / 1000, path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) sessions.delete(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!authRequired()) return { ok: true };
    return { ok: isAuthenticated(req) };
  });
}

/** 登录是否启用（settings.auth_required；默认关闭，稳定后再开启） */
export function authRequired(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'auth_required'").get() as { value?: string } | undefined;
    if (!row || row.value === undefined) return false;
    return String(row.value).toLowerCase() === 'true' || String(row.value) === '1';
  } catch {
    return false;
  }
}

/** 需要登录的路由注册入口：仅保护 /api/* 与 /ws；静态资源与健康检查公开 */
export function authGuard(app: FastifyInstance): void {
  const WHITELIST = new Set(['/api/auth/login', '/api/auth/me']);
  app.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path === '/ws') {
      if (!authRequired()) return done();
      if (WHITELIST.has(path)) return done();
      if (!isAuthenticated(req)) {
        reply.code(401).send({ error: 'unauthorized', message: '请先登录' });
        return;
      }
    }
    done();
  });
}
