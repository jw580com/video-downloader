import type { DB } from '../db/database.js';
import type { Settings } from '../db/settings.js';
import { getTask, updateTask, type TaskRow } from '../db/tasks.js';
import { log } from '../logger.js';
import { sleep } from '../util.js';
import type { DownloadEngine } from './download.js';

/** 并发受限的任务队列：超过并发上限的任务进入等待，空出槽位后自动启动 */
export class TaskQueue {
  private waiting: string[] = [];
  private active = new Set<string>();
  private draining = false;
  private closed = false;
  private retryTimers = new Map<string, NodeJS.Timeout>();

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
    if (this.closed) return;
    const task = getTask(this.db, id);
    if (!task || task.status !== 'waiting') return;
    this.clearRetryTimer(id);
    if (this.waiting.includes(id)) return;
    if (opts.front) this.waiting.unshift(id);
    else this.waiting.push(id);
    // 任务仍在运行中（自动重试场景）：只登记到等待列表，
    // 由当前运行结束后的 drain() 重新启动，避免同任务并发执行。
    if (this.active.has(id)) return;
    void this.drain();
  }

  /** 失败后的延迟重试（指数退避），到点后重新入队 */
  scheduleRetry(id: string, delayMs: number): void {
    if (this.closed) return;
    this.clearRetryTimer(id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const task = getTask(this.db, id);
      if (task && task.status === 'waiting') this.enqueue(id, { front: true });
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  private clearRetryTimer(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      const max = this.getSettings().maxConcurrency;
      while (this.active.size < max && this.waiting.length > 0) {
        const id = this.waiting.shift()!;
        const task = getTask(this.db, id);
        if (!task || task.status !== 'waiting') continue;
        if (this.active.has(id)) {
          // 任务仍在运行（通常是在自动重试/恢复过程中）：保留在等待队列，
          // 等当前运行结束后由 start() 的 finally 再次 drain，绝不能丢弃。
          this.waiting.unshift(id);
          break;
        }
        this.active.add(id);
        void this.start(id);
      }
    } finally {
      this.draining = false;
    }
  }

  private async start(id: string): Promise<void> {
    try {
      // drain() 与真正启动之间存在时间窗口（请求可能在此间取消任务），启动前再确认一次
      const latest = getTask(this.db, id);
      if (!latest || latest.status !== 'waiting') return;
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
    const task = getTask(this.db, id);
    if (!task) return false;
    if (task.status === 'waiting') {
      // 等待中的任务还没有开始下载，直接从队列移出并标记暂停
      this.clearRetryTimer(id);
      this.waiting = this.waiting.filter((x) => x !== id);
      updateTask(this.db, id, { status: 'paused', speedBps: 0, etaSec: 0 });
      log.info(`等待中的任务 ${id} 已暂停`);
      return true;
    }
    return this.engine.pause(id);
  }

  cancel(id: string): boolean {
    const task = getTask(this.db, id);
    if (!task) return false;
    this.clearRetryTimer(id);
    if (task.status === 'waiting') {
      // 包括“排队中”和“等待自动重试”的任务：都还没有运行中的下载进程
      this.waiting = this.waiting.filter((x) => x !== id);
      updateTask(this.db, id, {
        status: 'cancelled',
        speedBps: 0,
        etaSec: 0,
        downloadedBytes: 0,
        errorCode: 'CANCELLED',
        errorMessage: '任务已取消',
      });
      this.engine.cleanupTaskFiles(task);
      return true;
    }
    const ok = this.engine.cancel(id);
    if (ok) return true;
    // 任务不在引擎中（理论上不会发生）：直接清理可能残留的临时文件
    this.engine.cleanupTaskFiles(task);
    return false;
  }

  /**
   * 取消并等待运行中的任务真正退出（用于删除任务前清理文件），
   * 避免“删除记录后下载进程仍在写文件”的竞态。
   */
  async cancelAndWait(id: string, timeoutMs = 5000): Promise<boolean> {
    const task = getTask(this.db, id);
    if (!task) return false;
    const ok = this.cancel(id);
    const deadline = Date.now() + timeoutMs;
    while (this.active.has(id) && Date.now() < deadline) {
      await sleep(50);
    }
    if (this.active.has(id)) {
      log.warn(`任务 ${id} 在 ${timeoutMs}ms 内未退出，继续删除记录`);
    }
    this.engine.cleanupTaskFiles(task);
    return ok;
  }

  /** 继续已暂停的任务（保留已下载进度） */
  resume(id: string): void {
    const task = getTask(this.db, id);
    if (!task) return;
    if (task.status !== 'paused') return;
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
    this.clearRetryTimer(id);
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
      if (task.status !== 'waiting') {
        updateTask(this.db, id, { status: 'waiting', speedBps: 0, etaSec: 0 });
      }
      this.enqueue(id);
    }
  }

  onConcurrencyChanged(): void {
    void this.drain();
  }

  /** 清理任务留下的临时文件（.part / yt-dlp 临时分片） */
  cleanupTaskFiles(task: TaskRow): void {
    this.engine.cleanupTaskFiles(task);
  }

  /** 清理任务对应的日志文件 */
  cleanupTaskLog(id: string): void {
    this.engine.cleanupTaskLog(id);
  }

  /** 停止接收新任务、取消延迟重试，并等待运行中的任务退出（最多 timeoutMs） */
  async shutdown(timeoutMs = 4000): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.waiting = [];
    this.engine.abortAll();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    if (this.active.size > 0) {
      log.warn(`仍有 ${this.active.size} 个任务未在关闭时限内退出`);
    }
  }
}
