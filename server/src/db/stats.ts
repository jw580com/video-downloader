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
  // 没有任何已完成/失败任务时，成功率没有统计意义，返回 0 而不是伪造 100%
  const successRate = denominator > 0 ? Math.round((completedTotal / denominator) * 1000) / 10 : 0;

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

export interface PlatformOption {
  platform: string;
  name: string;
  count: number;
}

/** 任务出现过的全部平台（含自定义解析源），用于历史页的平台筛选 */
export function getPlatformOptions(db: DB): PlatformOption[] {
  const rows = db
    .prepare(
      `SELECT platform, MAX(platform_name) AS name, COUNT(*) AS c
       FROM tasks GROUP BY platform ORDER BY c DESC, platform ASC`,
    )
    .all() as RawRow[];
  return rows.map((r) => ({
    platform: String(r.platform),
    name: String(r.name || r.platform),
    count: Number(r.c),
  }));
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
    // 用日历日 + 1 天计算结束时间，避免夏令时切换日多算/少算一小时
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
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
