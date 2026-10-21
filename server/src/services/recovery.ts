import type { DB } from '../db/database.js';
import { getTask, listTaskIds } from '../db/tasks.js';
import { log } from '../logger.js';
import type { TaskQueue } from './queue.js';

/**
 * 服务重启后的任务恢复：
 * - waiting / parsing / downloading → 重新进入队列（downloading 的任务保留 .part 与
 *   已下载字节数，HTTP 引擎通过 Range 断点续传，yt-dlp 通过 .part 文件续传）
 * - paused → 保持暂停（由用户手动继续）
 * - completed → 不做任何处理（绝不重复下载）
 *
 * 注意：恢复范围不设上限，避免任务很多时历史遗留任务被永久卡住。
 */
export function recoverOnBoot(db: DB, queue: TaskQueue): { restored: number } {
  const ids = listTaskIds(db, { statuses: ['waiting', 'parsing', 'downloading'] });
  for (const id of ids) {
    const task = getTask(db, id);
    log.info(`恢复未完成任务 ${id}（${task?.status ?? 'unknown'}）：${task?.title ?? ''}`);
  }
  queue.recover(ids);
  log.info(`启动恢复完成：${ids.length} 个未完成任务已重新入队`);
  return { restored: ids.length };
}
