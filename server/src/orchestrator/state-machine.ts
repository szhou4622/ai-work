import type { TaskStatus } from '@workbench/shared';
import { getDb } from '../db/index.js';
import { recordAudit } from '../observability/audit.js';
import type { WsHub } from './ws.js';

/** 状态转换白名单（开发文档 §3.3） */
const ALLOWED: Record<string, string[]> = {
  CREATED: ['QUEUED', 'WAITING_CLARIFICATION', 'ARCHITECTURE', 'CANCELLED'],
  QUEUED: ['WAITING_CLARIFICATION', 'ARCHITECTURE', 'CANCELLED'],
  WAITING_CLARIFICATION: ['ARCHITECTURE', 'CANCELLED', 'NEEDS_HUMAN'],
  ARCHITECTURE: ['WAITING_DEVDOC_CONFIRM', 'WAITING_CLARIFICATION', 'NEEDS_HUMAN', 'CANCELLED'],
  WAITING_DEVDOC_CONFIRM: ['PLANNING', 'ARCHITECTURE', 'CANCELLED', 'NEEDS_HUMAN'],
  PLANNING: ['EXECUTING', 'NEEDS_HUMAN', 'CANCELLED'],
  EXECUTING: ['REVIEWING', 'FIXING', 'NEEDS_HUMAN', 'CANCELLED'],
  REVIEWING: ['INTEGRATING', 'FIXING', 'NEEDS_HUMAN', 'CANCELLED'],
  FIXING: ['REVIEWING', 'NEEDS_HUMAN', 'CANCELLED'],
  INTEGRATING: ['TESTING', 'NEEDS_HUMAN', 'CANCELLED'],
  TESTING: ['WAITING_ACCEPTANCE', 'FIXING', 'NEEDS_HUMAN', 'CANCELLED'],
  WAITING_ACCEPTANCE: ['COMPLETED', 'FIXING', 'NEEDS_HUMAN', 'CANCELLED'],
  WAITING_APPROVAL: ['EXECUTING', 'NEEDS_HUMAN', 'CANCELLED'],
  NEEDS_HUMAN: ['ARCHITECTURE', 'PLANNING', 'EXECUTING', 'REVIEWING', 'TESTING', 'WAITING_ACCEPTANCE', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['CANCELLED'],
  CANCELLED: [],
};

export interface TransitionInfo {
  nodeId?: string;
  agentRunId?: string;
  reason?: string;
  artifactRef?: string;
}

export function transition(taskId: string, to: TaskStatus, info: TransitionInfo = {}, hub?: WsHub): void {
  const db = getDb();
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const from = task.status;
  if (from === to) return;
  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态转换 ${from} → ${to}`);
  }
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(to, taskId);
  db.prepare(
    'INSERT INTO task_transitions (id, task_id, from_status, to_status, node_id, agent_run_id, reason, artifact_ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), taskId, from, to, info.nodeId ?? null, info.agentRunId ?? null, info.reason ?? null, info.artifactRef ?? null, Date.now());
  recordAudit(db, 'system', 'task:transition', taskId, { from, to, node: info.nodeId });
  hub?.publish({ type: 'task.status', task_id: taskId, status: to, ts: Date.now() });
}

export function currentStatus(taskId: string): string {
  const row = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  return row?.status ?? 'UNKNOWN';
}

export { ALLOWED };
