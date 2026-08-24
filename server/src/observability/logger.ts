import { redactText } from '../secrets/redact.js';
import type { SecretStore } from '../secrets/store.js';

let secrets: SecretStore | null = null;

export function initLogger(s: SecretStore): void {
  secrets = s;
}

/** 脱敏日志：所有已知 Secret 值与常见敏感模式在落盘前被替换（开发文档 §9.10） */
export function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const values = secrets?.allValues() ?? [];
  const base = redactText(msg, values);
  const extraStr = extra !== undefined ? ' ' + redactText(JSON.stringify(extra), values) : '';
  const line = `[${new Date().toISOString()}] [${level}] ${base}${extraStr}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
