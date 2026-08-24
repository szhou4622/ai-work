import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getDb } from '../db/index.js';
import { recordAudit } from '../observability/audit.js';

/**
 * 项目导入（开发文档 FR-17 / §13 P2）
 * - Git 地址 Clone
 * - 上传 zip（base64 JSON，免 multipart 依赖）
 * - 网页选文件夹逐文件上传（base64 JSON）
 */
export function registerProjectImportRoutes(app: FastifyInstance): void {
  const db = getDb();
  const projectsDir = path.join(DATA_DIR, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  // 由名称生成安全的项目目录（去重）
  const targetDir = (name: string): string => {
    const base = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
    let dir = path.join(projectsDir, base);
    let i = 2;
    while (existsSync(dir)) {
      dir = path.join(projectsDir, `${base}-${i}`);
      i++;
    }
    return dir;
  };

  const insertProject = (name: string, repoPath: string, source: string, gitUrl?: string) => {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO projects (id, name, repo_path, default_branch, source, git_url, context_config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, repoPath, 'main', source, gitUrl ?? null, '{}', Date.now());
    return id;
  };

  const ensureGit = (dir: string) => {
    if (!existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'AI Workbench'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'workbench@local'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'import: 初始代码'], { cwd: dir, stdio: 'pipe' });
    }
  };

  // 1) Git 地址导入
  app.post('/api/projects/import-git', async (req, reply) => {
    const { name, git_url } = (req.body ?? {}) as { name?: string; git_url?: string };
    if (!name || !git_url) return reply.code(400).send({ error: 'invalid_input', message: 'name 与 git_url 必填' });
    if (!/^https?:\/\//.test(git_url) && !/^git@/.test(git_url)) {
      return reply.code(400).send({ error: 'invalid_input', message: 'git_url 需为 https:// 或 git@ 形式' });
    }
    const dir = targetDir(name);
    try {
      execFileSync('git', ['clone', git_url, dir], { timeout: 10 * 60 * 1000, stdio: 'pipe' });
    } catch (err) {
      return reply.code(400).send({ error: 'clone_failed', message: `Git Clone 失败：${err instanceof Error ? err.message.slice(0, 300) : String(err)}` });
    }
    const id = insertProject(name, dir, 'git', git_url);
    recordAudit(db, 'user', 'project:import-git', id, { name, git_url });
    return { id, repo_path: dir };
  });

  // 2) 上传 zip（base64 JSON）
  app.post('/api/projects/import-upload', async (req, reply) => {
    const { name, zipBase64 } = (req.body ?? {}) as { name?: string; zipBase64?: string };
    if (!name || !zipBase64) return reply.code(400).send({ error: 'invalid_input', message: 'name 与 zipBase64 必填' });
    const tmpZip = path.join(DATA_DIR, 'tmp', `upload-${Date.now()}.zip`);
    mkdirSync(path.dirname(tmpZip), { recursive: true });
    try {
      writeFileSync(tmpZip, Buffer.from(zipBase64, 'base64'));
      const dir = targetDir(name);
      mkdirSync(dir, { recursive: true });
      execFileSync('python3', ['-c', `
import sys, zipfile, os
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for m in z.namelist():
        if m.endswith('/'): continue
        target = os.path.join(dst, m)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(m) as srcf, open(target, 'wb') as dstf:
            dstf.write(srcf.read())
`, tmpZip, dir], { timeout: 5 * 60 * 1000 });
      rmSync(tmpZip, { force: true });
      ensureGit(dir);
      const id = insertProject(name, dir, 'upload');
      recordAudit(db, 'user', 'project:import-upload', id, { name });
      return { id, repo_path: dir };
    } catch (err) {
      rmSync(tmpZip, { force: true });
      return reply.code(400).send({ error: 'import_failed', message: `导入失败：${err instanceof Error ? err.message.slice(0, 300) : String(err)}` });
    }
  });

  // 3) 网页选文件夹逐文件上传（base64 JSON，分批）
  app.post('/api/projects/import-files', async (req, reply) => {
    const { name, files, total, done } = (req.body ?? {}) as {
      name?: string;
      files?: { path: string; content: string }[];
      total?: number;
      done?: boolean;
    };
    if (!name || !Array.isArray(files)) return reply.code(400).send({ error: 'invalid_input', message: 'name 与 files 必填' });

    // 项目目录：首次调用创建，后续调用用内存缓存
    const dirKey = `import-files-dir:${name}`;
    let dir = (globalThis as any)[dirKey];
    if (!dir) {
      dir = targetDir(name);
      mkdirSync(dir, { recursive: true });
      (globalThis as any)[dirKey] = dir;
    }

    try {
      for (const f of files) {
        const p = f.path.replace(/^\/+/, '');
        if (!p || p.includes('..')) continue;
        const target = path.join(dir, p);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(f.content ?? '', 'base64'));
      }
      if (done) {
        ensureGit(dir);
        const id = insertProject(name, dir, 'upload');
        delete (globalThis as any)[dirKey];
        recordAudit(db, 'user', 'project:import-files', id, { name, total: total ?? files.length });
        return { id, repo_path: dir };
      }
      return { ok: true, received: files.length };
    } catch (err) {
      return reply.code(400).send({ error: 'import_failed', message: `导入失败：${err instanceof Error ? err.message.slice(0, 300) : String(err)}` });
    }
  });
}
