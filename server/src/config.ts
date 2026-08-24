import path from 'node:path';

export const PORT = Number(process.env.PORT ?? 8620);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
export const DB_FILE = path.join(DATA_DIR, 'workbench.db');
export const SECRET_STORE_FILE = path.join(DATA_DIR, 'secrets.enc');
export const MASTER_KEY_FILE = path.join(DATA_DIR, '.master-key');
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天
/** 可选：首次启动直接设置登录口令（否则自动生成并打印一次） */
export const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;

/** 配置常量：集中管理魔法数值 */
export const MAX_CONTEXT_CHARS = 14000; // 上下文注入字符数上限（防止模型上下文窗口溢出）
export const MAX_PARALLEL_EXECUTORS = 4; // 并行执行者上限
export const MAX_REVIEW_ITERATIONS = 3; // 审查返工最大迭代次数
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // Agent 执行超时（30 分钟）
