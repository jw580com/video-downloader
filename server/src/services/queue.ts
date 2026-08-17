import type { DB } from '../db/database.js';
import type { Settings } from '../db/settings.js';
import { getTask, updateTask } from '../db/tasks.js';
import { log } from '../logger.js';
import type { DownloadEngine } from './download.js';

/** 并发受限的任务队列：超过并发上限的任务进入等待，空出槽位后自动启动 */
export class TaskQueue {
  private waiting: string[] = [];
  private active = new Set<string>();
  private draining = false;

  constructor(
    private db: DB,
    private engine: DownloadEngine,
    private getSettings: () => Settings,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  snapshot(): { active: string[]; waiting: string[] } {
    return { active: [...this.active], waiting: [...this.waiting] };
  }

  enqueue(id: string, opts: { front?: boolean } = {}): void {
    const task = getTask(this.db, id);
    if (!task || task.status !== 'waiting') return;
    if (this.waiting.includes(id)) return;
    if (opts.front) this.waiting.unshift(id);
    else this.waiting.push(id);
    // 任务仍在运行中（自动重试场景）：只登记到等待列表，
    // 由当前运行结束后的 drain() 重新启动，避免同任务并发执行。
    if (this.active.has(id)) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const max = this.getSettings().maxConcurrency;
      while (this.active.size < max && this.waiting.length > 0) {
        const id = this.waiting.shift()!;
        const task = getTask(this.db, id);
        if (!task || task.status !== 'waiting') continue;
        if (this.active.has(id)) continue;
        this.active.add(id);
        void this.start(id);
      }
    } finally {
      this.draining = false;
    }
  }

  private async start(id: string): Promise<void> {
    try {
      await this.engine.runJob(id);
    } catch (e) {
      log.error(`任务 ${id} 异常退出`, e);
      const task = getTask(this.db, id);
      if (task && ['downloading', 'parsing', 'waiting'].includes(task.status)) {
        updateTask(this.db, id, {
          status: 'failed',
          errorCode: 'INTERNAL',
          errorMessage: '任务异常退出，请重试',
          speedBps: 0,
          etaSec: 0,
        });
      }
    } finally {
      this.active.delete(id);
      void this.drain();
    }
  }

  pause(id: string): boolean {
    return this.engine.pause(id);
  }

  cancel(id: string): boolean {
    const task = getTask(this.db, id);
    if (!task) return false;
    if (this.waiting.includes(id)) {
      this.waiting = this.waiting.filter((x) => x !== id);
      updateTask(this.db, id, {
        status: 'cancelled',
        speedBps: 0,
        etaSec: 0,
        downloadedBytes: 0,
        errorCode: 'CANCELLED',
        errorMessage: '任务已取消',
      });
      return true;
    }
    return this.engine.cancel(id);
  }

  /** 继续已暂停的任务（保留已下载进度） */
  resume(id: string): void {
    const task = getTask(this.db, id);
    if (!task) return;
    if (!['paused', 'waiting'].includes(task.status)) return;
    updateTask(this.db, id, {
      status: 'waiting',
      speedBps: 0,
      etaSec: 0,
      errorCode: '',
      errorMessage: '',
    });
    log.info(`任务 ${id} 继续（断点续传自 ${task.downloadedBytes} 字节）`);
    this.enqueue(id, { front: true });
  }

  /** 重试失败/已取消的任务（重置重试计数） */
  retry(id: string): void {
    const task = getTask(this.db, id);
    if (!task) return;
    if (!['failed', 'cancelled'].includes(task.status)) return;
    updateTask(this.db, id, {
      status: 'waiting',
      retryCount: 0,
      speedBps: 0,
      etaSec: 0,
      errorCode: '',
      errorMessage: '',
    });
    this.enqueue(id, { front: true });
  }

  /** 服务启动时批量恢复 */
  recover(ids: string[]): void {
    for (const id of ids) {
      const task = getTask(this.db, id);
      if (!task) continue;
      updateTask(this.db, id, { status: 'waiting', speedBps: 0, etaSec: 0 });
      this.enqueue(id);
    }
  }

  onConcurrencyChanged(): void {
    void this.drain();
  }

  shutdown(): void {
    this.engine.abortAll();
    this.waiting = [];
  }
}
