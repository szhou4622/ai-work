import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 按 schema.sql 建表，并记录 schema 版本 */
export function migrate(db: Database.Database): void {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(sql);
  // 增量迁移：老库补列
  const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as any[]).map((c) => c.name);
  if (!agentCols.includes('provider_key_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN provider_key_id TEXT');
  }
  const keyCols = (db.prepare("PRAGMA table_info(provider_keys)").all() as any[]).map((c) => c.name);
  if (!keyCols.includes('protocol')) {
    db.exec("ALTER TABLE provider_keys ADD COLUMN protocol TEXT DEFAULT 'openai'");
  }
  const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as any[]).map((c) => c.name);
  if (!taskCols.includes('agent_overrides')) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_overrides TEXT DEFAULT '{}'");
  }
  if (!taskCols.includes('auto_mode')) {
    db.exec('ALTER TABLE tasks ADD COLUMN auto_mode INTEGER DEFAULT 0');
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('schema_version', '3');
}
