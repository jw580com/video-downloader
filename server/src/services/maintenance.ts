import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/database.js';
import { getTask } from '../db/tasks.js';
import { config } from '../config.js';
import { log } from '../logger.js';

/** 任务日志默认保留 7 天；任务记录被删除时其日志会立即清理 */
const DEFAULT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['waiting', 'parsing', 'downloading', 'paused'];
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 启动时清理日志目录：
 * - 对应任务记录已删除的日志立即清理；
 * - 超过保留期的日志清理（运行中任务的日志跳过）。
 * 返回清理的文件数。
 */
export function cleanupStaleLogs(db: DB, maxAgeMs = DEFAULT_LOG_MAX_AGE_MS): number {
  const dir = path.join(config.dataDir, 'logs');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let deleted = 0;
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const base = name.slice(0, -'.log'.length);
    const isTaskLog = TASK_ID_RE.test(base);
    if (isTaskLog) {
      const task = getTask(db, base);
      if (!task) {
        try {
          fs.unlinkSync(full);
          deleted++;
        } catch {
          // ignore
        }
        continue;
      }
      if (ACTIVE_STATUSES.includes(task.status)) continue;
    }
    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(full);
        deleted++;
      } catch {
        // ignore
      }
    }
  }
  if (deleted > 0) log.info(`已清理 ${deleted} 个过期/孤儿日志文件`);
  return deleted;
}
