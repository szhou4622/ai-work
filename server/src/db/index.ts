import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { DB_FILE } from '../config.js';
import { migrate } from './migrate.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(DB_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
    _db = new Database(DB_FILE);
    _db.pragma('journal_mode = WAL');
    migrate(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
