import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** 审计日志（开发文档 §9.10）：状态转换、审批、取消、Secret 变更、fallback 等全部留痕 */
export function recordAudit(
  db: Database.Database,
  actor: string,
  action: string,
  target: string,
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO audit_logs (id, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), Date.now(), actor, action, target ?? '', JSON.stringify(detail ?? {}));
}
