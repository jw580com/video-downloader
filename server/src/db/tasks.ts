import type { DB } from './database.js';
import type { SQLInputValue } from 'node:sqlite';
import { nowMs } from '../util.js';

export type TaskStatus =
  | 'waiting'
  | 'parsing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const ALL_STATUSES: TaskStatus[] = [
  'waiting',
  'parsing',
  'downloading',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

export type TaskEngine = 'http' | 'ytdlp';

export interface TaskRow {
  id: string;
  url: string;
  platform: string;
  title: string;
  thumbnail: string;
  author: string;
  durationSec: number;
  quality: string;
  format: string;
  formatId: string;
  engine: TaskEngine;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  speedBps: number;
  etaSec: number;
  errorCode: string;
  errorMessage: string;
  filePath: string;
  folder: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** 实际下载地址（自定义解析源/脚本解析结果） */
  resolvedUrl: string;
  /** 下载请求附加头（JSON 字符串） */
  headers: string;
  /** 平台显示名（自定义解析源名称等） */
  platformName: string;
  /** 额外 yt-dlp 参数（每行一个，自定义解析源快照） */
  ytdlpArgs: string;
  /** 自定义解析源专用 Cookie 文件 */
  cookiesFile: string;
}

export interface NewTask {
  id: string;
  url: string;
  platform: string;
  title: string;
  thumbnail: string;
  author: string;
  durationSec: number;
  quality: string;
  format: string;
  formatId: string;
  engine: TaskEngine;
  totalBytes: number;
  folder: string;
  resolvedUrl?: string;
  headers?: string;
  platformName?: string;
  ytdlpArgs?: string;
  cookiesFile?: string;
}

interface RawRow {
  [key: string]: unknown;
}

function toTask(r: RawRow): TaskRow {
  return {
    id: String(r.id),
    url: String(r.url ?? ''),
    platform: String(r.platform ?? ''),
    title: String(r.title ?? ''),
    thumbnail: String(r.thumbnail ?? ''),
    author: String(r.author ?? ''),
    durationSec: Number(r.duration_sec ?? 0),
    quality: String(r.quality ?? ''),
    format: String(r.format ?? ''),
    formatId: String(r.format_id ?? ''),
    engine: r.engine === 'ytdlp' ? 'ytdlp' : 'http',
    status: String(r.status ?? 'waiting') as TaskStatus,
    totalBytes: Number(r.total_bytes ?? 0),
    downloadedBytes: Number(r.downloaded_bytes ?? 0),
    speedBps: Number(r.speed_bps ?? 0),
    etaSec: Number(r.eta_sec ?? 0),
    errorCode: String(r.error_code ?? ''),
    errorMessage: String(r.error_message ?? ''),
    filePath: String(r.file_path ?? ''),
    folder: String(r.folder ?? ''),
    retryCount: Number(r.retry_count ?? 0),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    resolvedUrl: String(r.resolved_url ?? ''),
    headers: String(r.headers ?? ''),
    platformName: String(r.platform_name ?? ''),
    ytdlpArgs: String(r.ytdlp_args ?? ''),
    cookiesFile: String(r.cookies_file ?? ''),
  };
}

export function createTask(db: DB, t: NewTask): TaskRow {
  const now = nowMs();
  db.prepare(
    `INSERT INTO tasks (
      id, url, platform, title, thumbnail, author, duration_sec,
      quality, format, format_id, engine, status,
      total_bytes, downloaded_bytes, speed_bps, eta_sec,
      error_code, error_message, file_path, folder, retry_count,
      created_at, updated_at, started_at, completed_at,
      resolved_url, headers, platform_name, ytdlp_args, cookies_file
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    t.id,
    t.url,
    t.platform,
    t.title,
    t.thumbnail,
    t.author,
    t.durationSec,
    t.quality,
    t.format,
    t.formatId,
    t.engine,
    'waiting',
    t.totalBytes,
    0,
    0,
    0,
    '',
    '',
    '',
    t.folder,
    0,
    now,
    now,
    null,
    null,
    t.resolvedUrl ?? '',
    t.headers ?? '',
    t.platformName ?? '',
    t.ytdlpArgs ?? '',
    t.cookiesFile ?? '',
  );
  return getTask(db, t.id)!;
}

export function getTask(db: DB, id: string): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawRow | undefined;
  return row ? toTask(row) : undefined;
}

const PATCH_COLUMNS: Record<string, string> = {
  status: 'status',
  totalBytes: 'total_bytes',
  downloadedBytes: 'downloaded_bytes',
  speedBps: 'speed_bps',
  etaSec: 'eta_sec',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  filePath: 'file_path',
  retryCount: 'retry_count',
  startedAt: 'started_at',
  completedAt: 'completed_at',
};

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'status'
    | 'totalBytes'
    | 'downloadedBytes'
    | 'speedBps'
    | 'etaSec'
    | 'errorCode'
    | 'errorMessage'
    | 'filePath'
    | 'retryCount'
    | 'startedAt'
    | 'completedAt'
  >
>;

export function updateTask(db: DB, id: string, patch: TaskPatch): void {
  const entries = Object.entries(patch).filter(([k]) => PATCH_COLUMNS[k]);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${PATCH_COLUMNS[k]} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowMs(), id);
}

export interface TaskFilter {
  statuses?: TaskStatus[];
  platform?: string;
  search?: string;
  sort?: 'created_at' | 'updated_at' | 'completed_at' | 'total_bytes';
  order?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

function buildWhere(filter: TaskFilter): { whereSql: string; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.statuses && filter.statuses.length > 0) {
    where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
    params.push(...filter.statuses);
  }
  if (filter.platform) {
    where.push('platform = ?');
    params.push(filter.platform);
  }
  if (filter.search) {
    where.push('(title LIKE ? OR url LIKE ? OR author LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

export function listTasks(
  db: DB,
  filter: TaskFilter = {},
): { items: TaskRow[]; total: number } {
  const { whereSql, params } = buildWhere(filter);
  const sort = filter.sort ?? 'created_at';
  const order = filter.order ?? 'DESC';
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM tasks ${whereSql}`).get(...params) as RawRow).c,
  );
  const rows = db
    .prepare(
      `SELECT * FROM tasks ${whereSql} ORDER BY ${sort} ${order}, created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RawRow[];
  return { items: rows.map(toTask), total };
}

/** 按筛选条件返回全部匹配任务的 id（不受分页限制，供批量操作使用） */
export function listTaskIds(db: DB, filter: TaskFilter = {}): string[] {
  const { whereSql, params } = buildWhere(filter);
  const rows = db
    .prepare(`SELECT id FROM tasks ${whereSql} ORDER BY created_at DESC`)
    .all(...params) as RawRow[];
  return rows.map((r) => String(r.id));
}

export function deleteTask(db: DB, id: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function clearFilePath(db: DB, id: string): void {
  db.prepare("UPDATE tasks SET file_path = '', updated_at = ? WHERE id = ?").run(nowMs(), id);
}

export function findCompletedByUrl(db: DB, url: string): TaskRow | undefined {
  const row = db
    .prepare("SELECT * FROM tasks WHERE url = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1")
    .get(url) as RawRow | undefined;
  return row ? toTask(row) : undefined;
}

/** 将运行中的任务重置为等待状态（服务重启恢复用） */
export function resetInterruptedToWaiting(db: DB): number {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'waiting', speed_bps = 0, eta_sec = 0, updated_at = ?
       WHERE status IN ('downloading', 'parsing')`,
    )
    .run(nowMs());
  return Number(r.changes);
}

export function countByStatus(db: DB): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all() as RawRow[];
  for (const r of rows) out[String(r.status)] = Number(r.c);
  return out;
}

export function sumCompletedBytes(db: DB): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(total_bytes), 0) AS s FROM tasks WHERE status = 'completed'")
    .get() as RawRow;
  return Number(row.s);
}

/** 清理指定任务的部分下载文件（用于取消/删除） */
export function partFilesOf(task: { filePath: string }): string[] {
  return task.filePath ? [task.filePath + '.part'] : [];
}
