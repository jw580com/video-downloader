import type { DB } from '../db/database.js';
import { listTasks } from '../db/tasks.js';
import { log } from '../logger.js';
import type { TaskQueue } from './queue.js';

/**
 * 服务重启后的任务恢复：
 * - waiting / parsing / downloading → 重新进入队列（downloading 的任务保留 .part 与
 *   已下载字节数，HTTP 引擎通过 Range 断点续传，yt-dlp 通过 .part 文件续传）
 * - paused → 保持暂停（由用户手动继续）
 * - completed → 不做任何处理（绝不重复下载）
 */
export function recoverOnBoot(db: DB, queue: TaskQueue): { restored: number } {
  const rows = listTasks(db, {
    statuses: ['waiting', 'parsing', 'downloading'],
    sort: 'created_at',
    order: 'ASC',
    limit: 2000,
  });
  const ids: string[] = [];
  for (const t of rows.items) {
    const wasRunning = t.status === 'downloading' || t.status === 'parsing';
    ids.push(t.id);
    log.info(
      `恢复任务 ${t.id}（${t.status} → waiting${wasRunning ? '，断点续传' : ''}）：${t.title}`,
    );
  }
  queue.recover(ids);
  log.info(`启动恢复完成：${ids.length} 个未完成任务已重新入队`);
  return { restored: ids.length };
}
