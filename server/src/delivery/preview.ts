import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/index.js';

export interface PreviewResult {
  ok: boolean;
  port?: number;
  pid?: number;
  url?: string;
  error?: string;
}

/** 服务器公网地址（可被 PUBLIC_HOST 环境变量覆盖） */
export function getPublicHost(): string {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

/** 从端口池分配一个空闲端口（开发文档 §11 preview_port_range） */
export async function allocPreviewPort(): Promise<number | null> {
  const range = String((getDb().prepare("SELECT value FROM settings WHERE key='preview_port_range'").get() as any)?.value ?? '"45000-45019"').replace(/"/g, '');
  const [lo, hi] = range.split('-').map(Number);
  for (let p = lo; p <= hi; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 800).unref();
  });
}

/**
 * 启动网页项目预览（开发文档 §8.8 / FR-13）
 * 策略：package.json 的 dev/start 脚本（注入 PORT 环境变量）→ 兜底静态站点 python3 -m http.server
 */
export async function startPreview(repo: string): Promise<PreviewResult> {
  const port = await allocPreviewPort();
  if (!port) return { ok: false, error: '预览端口池已满' };

  // 方案 1：package.json 脚本（注入 PORT）
  const pkgPath = path.join(repo, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const script = pkg.scripts?.dev || pkg.scripts?.start;
      if (script) {
        const child = spawn('npm', ['run', pkg.scripts?.dev ? 'dev' : 'start', '--', '--host', '0.0.0.0', '--port', String(port)], {
          cwd: repo,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' },
        });
        child.unref();
        if (await waitPort(port, 12_000)) {
          return { ok: true, port, pid: child.pid, url: `http://${getPublicHost()}:${port}` };
        }
        try { process.kill(-child.pid!); } catch { /* ignore */ }
      }
    } catch { /* 忽略，走静态方案 */ }
  }

  // 方案 2：静态站点
  if (existsSync(path.join(repo, 'index.html'))) {
    const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '0.0.0.0'], {
      cwd: repo,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (await waitPort(port, 5000)) {
      return { ok: true, port, pid: child.pid, url: `http://${getPublicHost()}:${port}` };
    }
    return { ok: false, error: '静态服务启动失败' };
  }

  return { ok: false, error: '未识别为网页项目（无 package.json 脚本或 index.html）' };
}

/** 记录交付物到 deliveries 表 */
export function recordDelivery(taskId: string, kind: 'preview' | 'package', urlOrPath: string, port?: number, pid?: number): void {
  getDb().prepare(
    'INSERT INTO deliveries (id, task_id, kind, url_or_path, port, pid, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), taskId, kind, urlOrPath, port ?? null, pid ?? null, 'active', Date.now());
}
