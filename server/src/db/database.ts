import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  format_id TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT 'http',
  status TEXT NOT NULL DEFAULT 'waiting',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  speed_bps REAL NOT NULL DEFAULT 0,
  eta_sec INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_platform ON tasks(platform);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parsers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domains TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ytdlp',
  enabled INTEGER NOT NULL DEFAULT 1,
  ytdlp_args TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  cookies_file TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDatabase(): DB {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // 旧数据库迁移：为 tasks 表补充新增列
  ensureColumn(db, 'tasks', 'resolved_url', "resolved_url TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'tasks', 'headers', "headers TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'tasks', 'platform_name', "platform_name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'tasks', 'ytdlp_args', "ytdlp_args TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'tasks', 'cookies_file', "cookies_file TEXT NOT NULL DEFAULT ''");
  log.info(`数据库已打开：${config.dbPath}`);
  return db;
}
