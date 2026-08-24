import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getDb } from '../db/index.js';
import { recordAudit } from '../observability/audit.js';

/** 交付物：打包下载（开发文档 §8.8 / FR-13） */
export function registerDeliveryRoutes(app: FastifyInstance): void {
  const db = getDb();

  // 生成成品 zip 包（排除 node_modules/.git/.worktrees/data）
  app.post('/api/tasks/:id/package', async (req, reply) => {
    const id = (req.params as any).id;
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as any;
    const project = task ? db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(task.project_id) as any : null;
    if (!project || !project.repo_path || !existsSync(project.repo_path)) {
      return reply.code(404).send({ error: 'not_found', message: '项目目录不存在' });
    }
    const deliveriesDir = path.join(DATA_DIR, 'deliveries');
    mkdirSync(deliveriesDir, { recursive: true });
    const zipPath = path.join(deliveriesDir, `task-${id}.zip`);
    const src = project.repo_path;
    try {
      execFileSync('python3', [
        '-c',
        `
import sys, zipfile, os
src, dst = sys.argv[1], sys.argv[2]
exclude_dirs = {'node_modules', '.git', '.worktrees', 'data'}
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src)
            z.write(full, rel)
print('ok')
`,
        src,
        zipPath,
      ], { timeout: 120000 });
    } catch (err) {
      return reply.code(500).send({ error: 'package_failed', message: err instanceof Error ? err.message : String(err) });
    }
    db.prepare(
      "INSERT INTO deliveries (id, task_id, kind, url_or_path, status, created_at) VALUES (?, ?, 'package', ?, 'active', ?)",
    ).run(crypto.randomUUID(), id, zipPath, Date.now());
    recordAudit(db, 'user', 'delivery:package', id, {});
    return { ok: true, path: zipPath };
  });

  // 下载成品
  app.get('/api/tasks/:id/package.zip', async (req, reply) => {
    const id = (req.params as any).id;
    const p = path.join(DATA_DIR, 'deliveries', `task-${id}.zip`);
    if (!existsSync(p)) return reply.code(404).send({ error: 'not_found', message: '尚未生成成品包，请先 POST /api/tasks/:id/package' });
    return reply.type('application/zip').send(readFileSync(p));
  });

  // 交付物列表
  app.get('/api/tasks/:id/deliveries', async (req, reply) => {
    const id = (req.params as any).id;
    const rows = db.prepare('SELECT * FROM deliveries WHERE task_id = ? ORDER BY created_at ASC').all(id);
    return rows.map((r: any) => ({ ...r, url: r.kind === 'package' ? `/api/tasks/${id}/package.zip` : r.url_or_path }));
  });
}
