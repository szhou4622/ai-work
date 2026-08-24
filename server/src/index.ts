import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, DATA_DIR } from './config.js';import { getDb, closeDb } from './db/index.js';
import { ensureSettings, ensureBuiltinWorkflows, ensureDefaultRolesAndRuntimes } from './db/seed.js';
import { SecretStore } from './secrets/store.js';
import { initLogger, log } from './observability/logger.js';
import { registerAuthRoutes, authGuard, ensureAccessPassword } from './routes/auth.js';
import { registerCrud } from './routes/crud.js';
import { registerProviderRoutes, registerProviderKeyRoutes } from './routes/providers.js';
import { registerProjectImportRoutes } from './routes/projects-import.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerDeliveryRoutes } from './routes/delivery.js';
import { WsHub } from './orchestrator/ws.js';
import { initEngine, recoverOnBoot } from './orchestrator/engine.js';
import { recordAudit } from './observability/audit.js';

async function main(): Promise<void> {
  // 初始化基础设施
  const db = getDb();
  ensureSettings(db);
  ensureBuiltinWorkflows(db);
  ensureDefaultRolesAndRuntimes(db);
  ensureAccessPassword();

  const secrets = new SecretStore();
  initLogger(secrets);
  log('info', 'workbench 启动中', { db: 'ok', workflows: 'seeded', roles: 'seeded' });

  const app = Fastify({ logger: false });
  await app.register(cookie);

  // 构建版本号（部署时写入 data/build-info.json；前端据此自动检测旧页面并强刷）
  let buildId = 'dev';
  try {
    const info = JSON.parse(readFileSync(path.join(DATA_DIR, 'build-info.json'), 'utf-8'));
    buildId = String(info.build_id ?? 'dev');
  } catch { /* 无构建信息 */ }

  // 所有响应携带版本头 + API 禁用缓存
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-App-Version', buildId);
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  // 写请求日志（诊断用：记录所有 API 请求，含 GET）
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      log('info', `[req] ${req.method} ${req.url} -> ${reply.statusCode}`);
    }
  });

  // 前端静态资源（web/dist，存在则托管；SPA 回退 index.html）
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      cacheControl: false, // 完全由 setHeaders 管理缓存策略
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          // index.html 不缓存：每次加载都拉取最新 JS 引用
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\/assets\//.test(filePath)) {
          // 带内容 hash 的静态资源可长缓存（内容变了文件名会变）
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.sendFile('index.html');
    });
  }

  // 健康检查（免鉴权）
  app.get('/healthz', async () => {
    const dbHealthy = (() => {
      try {
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    })();
    const dataDir = existsSync(DATA_DIR);
    return {
      ok: dbHealthy && dataDir,
      service: 'ai-workbench',
      version: '0.1.0',
      build_id: buildId,
      db: dbHealthy,
      data_dir: dataDir,
      time: new Date().toISOString(),
    };
  });

  // 鉴权
  authGuard(app);
  registerAuthRoutes(app);

  // Provider（含 Secret 存储与 Test Connection）
  registerProviderRoutes(app, secrets);
  registerProviderKeyRoutes(app, secrets);
  registerProjectImportRoutes(app);
  registerBillingRoutes(app, secrets);

  // 六层实体 + 运行实体的标准 CRUD（开发文档 §7.1 / §7.2）
  registerCrud(app, 'projects', { table: 'projects', jsonCols: ['context_config'] });
  registerCrud(app, 'tasks', { table: 'tasks', jsonCols: ['budget_config', 'agent_overrides'] });
  registerCrud(app, 'workflows', { table: 'workflows', jsonCols: ['definition'], protectedCols: ['id', 'created_at', 'builtin'] });
  registerCrud(app, 'roles', { table: 'roles', jsonCols: ['permission_defaults'] });
  registerCrud(app, 'agents', { table: 'agents', jsonCols: ['permissions', 'tools', 'retry_policy', 'review_policy'] });
  registerCrud(app, 'runtimes', { table: 'runtimes', jsonCols: ['config'] });
  registerCrud(app, 'models', { table: 'models', jsonCols: ['capabilities', 'aliases'] });
  registerCrud(app, 'billing-routes', { table: 'billing_routes', jsonCols: ['price_table', 'policy'] });
  registerCrud(app, 'presets', { table: 'presets', jsonCols: ['role_agent_map'] });
  registerCrud(app, 'messages', { table: 'messages' });
  registerCrud(app, 'project-memories', { table: 'project_memories' });
  registerCrud(app, 'deliveries', { table: 'deliveries' });

  registerSettingsRoutes(app);
  registerRunRoutes(app, secrets);
  registerTaskRoutes(app);
  registerUsageRoutes(app);
  registerDeliveryRoutes(app);

  // 工作流引擎 + WebSocket 实时通道
  const hub = new WsHub();
  hub.register(app);
  initEngine(secrets, hub);
  recoverOnBoot();

  // 审计：配置类操作
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/providers') || req.url.startsWith('/api/secrets')) {
      const status = reply.statusCode;
      const action = req.method + ' ' + req.url.split('?')[0];
      if (status < 400 && req.method !== 'GET') {
        recordAudit(db, 'user', 'config:' + req.method.toLowerCase(), req.url.split('?')[0], { status });
      }
    }
  });

  await app.listen({ port: PORT, host: HOST });
  log('info', `workbench 已启动 http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
