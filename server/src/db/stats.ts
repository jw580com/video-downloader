import type { DB } from './database.js';
import type { TaskRow } from './tasks.js';
import { listTasks } from './tasks.js';
import type { SQLInputValue } from 'node:sqlite';

interface RawRow {
  [key: string]: unknown;
}

function one(db: DB, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as RawRow | undefined;
  return Number(row?.['c'] ?? 0);
}

export interface StatsOverview {
  todayTasks: number;
  todayCompleted: number;
  downloading: number;
  todayFailed: number;
  totalBytes: number;
  totalTasks: number;
  completedTotal: number;
  failedTotal: number;
  successRate: number;
}

export function getOverview(db: DB): StatsOverview {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const ds = dayStart.getTime();

  const todayTasks = one(db, 'SELECT COUNT(*) AS c FROM tasks WHERE created_at >= ?', ds);
  const todayCompleted = one(
    db,
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'completed' AND completed_at >= ?",
    ds,
  );
  const downloading = one(
    db,
    "SELECT COUNT(*) AS c FROM tasks WHERE status IN ('downloading','parsing','waiting')",
  );
  const todayFailed = one(
    db,
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed' AND updated_at >= ?",
    ds,
  );
  const totalBytes = one(
    db,
    "SELECT COALESCE(SUM(total_bytes), 0) AS c FROM tasks WHERE status = 'completed'",
  );
  const totalTasks = one(db, 'SELECT COUNT(*) AS c FROM tasks');
  const completedTotal = one(db, "SELECT COUNT(*) AS c FROM tasks WHERE status = 'completed'");
  const failedTotal = one(db, "SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed'");
  const denominator = completedTotal + failedTotal;
  const successRate = denominator > 0 ? Math.round((completedTotal / denominator) * 1000) / 10 : 100;

  return {
    todayTasks,
    todayCompleted,
    downloading,
    todayFailed,
    totalBytes,
    totalTasks,
    completedTotal,
    failedTotal,
    successRate,
  };
}

export interface PlatformCount {
  platform: string;
  count: number;
}

export function getPlatformCounts(db: DB): PlatformCount[] {
  const rows = db
    .prepare(
      "SELECT platform, COUNT(*) AS c FROM tasks WHERE status = 'completed' GROUP BY platform ORDER BY c DESC",
    )
    .all() as RawRow[];
  return rows.map((r) => ({ platform: String(r.platform), count: Number(r.c) }));
}

export interface DailyStat {
  date: string;
  label: string;
  count: number;
  bytes: number;
}

export function getDaily(db: DB, days = 14): DailyStat[] {
  const out: DailyStat[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const start = day.getTime();
    const end = day.getTime() + 86400000;
    const count = one(
      db,
      "SELECT COUNT(*) AS c FROM tasks WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?",
      start,
      end,
    );
    const bytes = one(
      db,
      "SELECT COALESCE(SUM(total_bytes), 0) AS c FROM tasks WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?",
      start,
      end,
    );
    out.push({
      date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
      label: `${day.getMonth() + 1}/${day.getDate()}`,
      count,
      bytes,
    });
  }
  return out;
}

export function getRecent(db: DB, limit = 6): TaskRow[] {
  return listTasks(db, { sort: 'created_at', order: 'DESC', limit }).items;
}

export function getAllStats(db: DB): {
  overview: StatsOverview;
  platforms: PlatformCount[];
  daily: DailyStat[];
  recent: TaskRow[];
} {
  return {
    overview: getOverview(db),
    platforms: getPlatformCounts(db),
    daily: getDaily(db, 14),
    recent: getRecent(db, 6),
  };
}
