import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { DB } from '../db/database.js';
import type { Settings } from '../db/settings.js';
import { getTask, updateTask, type TaskRow } from '../db/tasks.js';
import { AppError, isAppError } from '../errors.js';
import { log } from '../logger.js';
import { ensureDir, freeDiskBytes, safeFileName, sleep, tailOfFile } from '../util.js';
import { config } from '../config.js';
import type { TaskQueue } from './queue.js';
import { buildFormatSelector, findYtdlp, hasFfmpeg, mapYtdlpError, ytdlpEnv } from './ytdlp.js';
import { createProxyAgent } from './proxy.js';
import { USER_AGENT } from './metadata.js';

interface JobControl {
  pauseRequested: boolean;
  cancelRequested: boolean;
  req?: http.ClientRequest;
  proc?: ChildProcess;
}

class JobAbort extends Error {
  constructor(public kind: 'paused' | 'cancelled') {
    super(kind);
    this.name = 'JobAbort';
  }
}

interface HttpEnv {
  finalPath: string;
  partPath: string;
  limitBps: number;
  timeoutMs: number;
  proxyUrl: string;
}

/** yt-dlp / 直链下载可能产生的最终文件扩展名 */
const KNOWN_EXTS = [
  'mp4',
  'webm',
  'mkv',
  'm4a',
  'mp3',
  'mov',
  'm4v',
  'avi',
  'flv',
  'ts',
  'aac',
  'wav',
  'ogg',
  'opus',
  'flac',
];

/** 重定向时不应跨源携带的敏感请求头 */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export class DownloadEngine {
  private jobs = new Map<string, JobControl>();
  private shuttingDown = false;

  constructor(
    private db: DB,
    private getSettings: () => Settings,
    private getQueue: () => TaskQueue,
  ) {}

  activeCount(): number {
    return this.jobs.size;
  }

  isActive(id: string): boolean {
    return this.jobs.has(id);
  }

  /** 执行一个任务（不抛错；所有异常转为任务失败/暂停/取消状态） */
  async runJob(id: string): Promise<void> {
    const task = getTask(this.db, id);
    // 只接受“等待中”的任务：任务可能在入队后被取消/删除
    if (!task || task.status !== 'waiting') return;
    const ctl: JobControl = { pauseRequested: false, cancelRequested: false };
    this.jobs.set(id, ctl);
    updateTask(this.db, id, {
      status: 'parsing',
      startedAt: task.startedAt ?? Date.now(),
      speedBps: 0,
      etaSec: 0,
      errorCode: '',
      errorMessage: '',
    });
    try {
      if (task.engine === 'ytdlp') {
        await this.runYtdlpJob(task, ctl);
      } else {
        await this.runHttpJob(task, ctl);
      }
    } catch (e) {
      await this.handleJobError(task, e);
    } finally {
      this.jobs.delete(id);
    }
  }

  pause(id: string): boolean {
    const ctl = this.jobs.get(id);
    if (!ctl) return false;
    ctl.pauseRequested = true;
    updateTask(this.db, id, { status: 'paused', speedBps: 0, etaSec: 0 });
    // 立即中断挂起中的请求/子进程，避免等待响应超时
    try {
      ctl.req?.destroy(new Error('vdm-user-abort'));
    } catch {
      // ignore
    }
    try {
      ctl.proc?.kill();
    } catch {
      // ignore
    }
    log.info(`任务 ${id} 暂停请求`);
    return true;
  }

  /** 取消任务（含等待中的任务统一由队列层处理，这里处理运行中的） */
  cancel(id: string): boolean {
    const ctl = this.jobs.get(id);
    if (!ctl) return false;
    ctl.cancelRequested = true;
    updateTask(this.db, id, { status: 'cancelled', speedBps: 0, etaSec: 0, downloadedBytes: 0 });
    try {
      ctl.req?.destroy(new Error('vdm-user-abort'));
    } catch {
      // ignore
    }
    try {
      ctl.proc?.kill();
    } catch {
      // ignore
    }
    log.info(`任务 ${id} 取消请求`);
    return true;
  }

  abortAll(): void {
    this.shuttingDown = true;
    for (const ctl of this.jobs.values()) {
      ctl.pauseRequested = true;
      try {
        ctl.req?.destroy(new Error('vdm-shutdown'));
      } catch {
        // ignore
      }
      try {
        ctl.proc?.kill();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 删除任务留下的临时文件（.part / yt-dlp 临时分片）。
   * 仅删除可确定属于“未完成下载”的文件，绝不删除已完成的正片。
   */
  cleanupTaskFiles(task: TaskRow): void {
    if (task.engine === 'ytdlp') {
      this.removeYtdlpFiles(task, this.outputPrefix(task), 'temps');
      // 兼容旧版本输出模板（标题 [formatId]，不含任务短 ID）留下的 .part
      const legacyPrefix = `${safeFileName(task.title || 'video')} [${safeFileName(task.formatId || 'na', 'na').slice(0, 40)}]`;
      if (legacyPrefix !== this.outputPrefix(task)) {
        this.removeYtdlpFilesWithPrefix(task.folder, legacyPrefix, 'temps');
      }
      return;
    }
    try {
      const part = `${this.buildHttpPath(task)}.part`;
      this.removeFileEventually(part);
    } catch {
      // ignore
    }
  }

  /** 删除任务对应的 yt-dlp 日志文件（删除任务记录时调用） */
  cleanupTaskLog(id: string): void {
    this.removeFileEventually(path.join(config.dataDir, 'logs', `${id}.log`));
  }

  /** 删除文件；Windows 上句柄可能尚未释放，失败时短延迟重试几次 */
  private removeFileEventually(file: string, attempts = 5): void {
    const tryRemove = (left: number): void => {
      try {
        if (!fs.existsSync(file)) return;
        fs.unlinkSync(file);
      } catch {
        if (left > 1) {
          const timer = setTimeout(() => tryRemove(left - 1), 250);
          timer.unref?.();
        }
      }
    };
    tryRemove(attempts);
  }

  private async handleJobError(task: TaskRow, e: unknown): Promise<void> {
    const cur = getTask(this.db, task.id) ?? task;
    if (e instanceof JobAbort) {
      // 仅在任务仍处于运行状态时才写入终态，避免覆盖用户后续的暂停/继续/取消操作
      if (e.kind === 'cancelled') {
        this.removePartFile(task);
        if (['downloading', 'parsing', 'waiting', 'paused'].includes(cur.status)) {
          updateTask(this.db, task.id, {
            status: 'cancelled',
            speedBps: 0,
            etaSec: 0,
            downloadedBytes: 0,
            errorCode: 'CANCELLED',
            errorMessage: '任务已取消',
          });
        }
      } else if (this.shuttingDown) {
        // 服务关闭中：保留未完成状态，重启后自动恢复
        if (['downloading', 'parsing'].includes(cur.status)) {
          updateTask(this.db, task.id, { status: 'downloading', speedBps: 0, etaSec: 0 });
        }
      } else if (['downloading', 'parsing'].includes(cur.status)) {
        updateTask(this.db, task.id, { status: 'paused', speedBps: 0, etaSec: 0 });
      }
      return;
    }

    // 用户已取消/暂停（例如网络错误与用户操作同时发生）：尊重用户操作，不覆盖状态
    if (cur.status === 'cancelled' || cur.status === 'paused') {
      if (cur.status === 'cancelled') this.cleanupTaskFiles(cur);
      return;
    }

    const appErr = isAppError(e) ? e : new AppError('INTERNAL', '任务异常退出，请重试');
    const settings = this.getSettings();
    // 只有网络/超时/临时不可用等可恢复错误才自动重试；
    // 需要登录、视频不存在、磁盘已满、缺少 yt-dlp 等错误重试也不会成功。
    const retryable = ['NETWORK_ERROR', 'TIMEOUT', 'VIDEO_UNAVAILABLE', 'INTERNAL'].includes(
      appErr.code,
    );
    if (retryable && cur.retryCount < settings.autoRetries) {
      const n = cur.retryCount + 1;
      updateTask(this.db, task.id, {
        status: 'waiting',
        speedBps: 0,
        etaSec: 0,
        retryCount: n,
        errorCode: appErr.code,
        errorMessage: `${appErr.message}（自动重试 ${n}/${settings.autoRetries}）`,
      });
      // 指数退避（1s、2s、4s…，上限 30s），避免网络故障时高频重试
      const delay = Math.min(30_000, 1000 * 2 ** (n - 1));
      log.info(`任务 ${task.id} 将在 ${Math.round(delay / 1000)} 秒后自动重试（${n}/${settings.autoRetries}）`);
      this.getQueue().scheduleRetry(task.id, delay);
      return;
    }
    updateTask(this.db, task.id, {
      status: 'failed',
      speedBps: 0,
      etaSec: 0,
      retryCount: cur.retryCount,
      errorCode: appErr.code,
      errorMessage: appErr.message,
    });
    log.warn(`任务 ${task.id} 失败：${appErr.code} ${appErr.message}`);
  }

  // ============ HTTP 直链下载（支持断点续传 / 限速 / 暂停 / 取消） ============

  private buildHttpPath(task: TaskRow): string {
    const raw = (task.format || 'mp4').toLowerCase().replace(/^\./, '');
    // 只允许安全扩展名，杜绝通过 format 字段注入路径分隔符（路径穿越）
    const ext = /^[a-z0-9]{1,10}$/.test(raw) ? raw : 'mp4';
    let base = safeFileName(task.title || 'video');
    if (!base.toLowerCase().endsWith(`.${ext}`)) base += `.${ext}`;
    const stem = base.slice(0, base.length - ext.length - 1);
    return path.join(task.folder, `${stem} [${task.id.slice(0, 6)}].${ext}`);
  }

  private parseExtraHeaders(task: TaskRow): http.OutgoingHttpHeaders {
    const extraHeaders: http.OutgoingHttpHeaders = {};
    try {
      const parsed: unknown = JSON.parse(task.headers || '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== 'string' || !v) continue;
          // 过滤非法头部值，避免 http.get 同步抛错或头注入
          if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
          extraHeaders[k] = v;
        }
      }
    } catch {
      // ignore
    }
    return extraHeaders;
  }

  private async runHttpJob(task: TaskRow, ctl: JobControl): Promise<void> {
    const settings = this.getSettings();
    const finalPath = this.buildHttpPath(task);
    const partPath = `${finalPath}.part`;
    ensureDir(path.dirname(finalPath));
    const url = task.resolvedUrl || task.url;
    const extraHeaders = this.parseExtraHeaders(task);

    // 以 .part 实际大小为准：数据库进度可能因进程崩溃而落后于文件，
    // 用数据库值续传会重复追加数据、导致文件损坏。
    let offset = 0;
    try {
      if (fs.existsSync(partPath)) offset = fs.statSync(partPath).size;
    } catch {
      offset = 0;
    }
    if (task.totalBytes > 0 && offset > task.totalBytes) {
      // 部分文件比预期还大，视为损坏，重新下载
      try {
        fs.unlinkSync(partPath);
      } catch {
        // ignore
      }
      offset = 0;
    }
    updateTask(this.db, task.id, {
      status: 'downloading',
      downloadedBytes: offset,
      startedAt: task.startedAt ?? Date.now(),
      errorCode: '',
      errorMessage: '',
    });
    const env: HttpEnv = {
      finalPath,
      partPath,
      limitBps: settings.maxSpeedKBps > 0 ? settings.maxSpeedKBps * 1024 : 0,
      timeoutMs: Math.max(5000, settings.timeoutSec * 1000),
      proxyUrl: settings.proxyUrl,
    };
    await this.httpAttempt(task, ctl, env, offset, 0, url, extraHeaders);
  }

  private async httpAttempt(
    task: TaskRow,
    ctl: JobControl,
    env: HttpEnv,
    offset: number,
    redirectCount: number,
    url: string,
    extraHeaders: http.OutgoingHttpHeaders = {},
  ): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AppError('VIDEO_UNAVAILABLE', '下载地址无效');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new AppError('VIDEO_UNAVAILABLE', '下载地址必须是 http(s) 链接');
    }
    const mod = u.protocol === 'https:' ? https : http;
    const headers: http.OutgoingHttpHeaders = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...extraHeaders,
    };
    if (offset > 0) headers.range = `bytes=${offset}-`;
    const agent = createProxyAgent(u.href, env.proxyUrl, { timeoutMs: env.timeoutMs });
    const req = mod.get(u, { headers, timeout: env.timeoutMs, ...(agent ? { agent } : {}) });
    ctl.req = req;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let responseStarted = false;
      const settleErr = (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      req.on('timeout', () => {
        req.destroy(new Error('vdm-timeout'));
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        // 响应已交给 handleHttpResponse 处理时，由它负责结束 Promise，
        // 避免 runJob 提前退出而下载协程仍在写文件（暂停/取消/断流的竞态）。
        if (responseStarted) return;
        if (ctl.cancelRequested) {
          settleErr(new JobAbort('cancelled'));
          return;
        }
        if (ctl.pauseRequested) {
          settleErr(new JobAbort('paused'));
          return;
        }
        const msg = String(e?.message ?? '');
        if (msg.includes('vdm-timeout')) settleErr(new AppError('TIMEOUT'));
        else {
          const proxyHint = env.proxyUrl ? `（代理 ${env.proxyUrl}）` : '';
          settleErr(
            new AppError('NETWORK_ERROR', `网络连接中断（${e?.code ?? 'unknown'}）${proxyHint}`),
          );
        }
      });
      req.on('response', (res) => {
        responseStarted = true;
        void this.handleHttpResponse(task, ctl, env, res, offset, redirectCount, url, extraHeaders)
          .then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch(settleErr);
      });
    });
  }

  private async handleHttpResponse(
    task: TaskRow,
    ctl: JobControl,
    env: HttpEnv,
    res: http.IncomingMessage,
    offset: number,
    redirectCount: number,
    url: string,
    extraHeaders: http.OutgoingHttpHeaders,
  ): Promise<void> {
    const code = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(code)) {
      res.resume();
      if (redirectCount >= 5) throw new AppError('NETWORK_ERROR', '重定向次数过多');
      const location = res.headers.location;
      if (!location) throw new AppError('VIDEO_UNAVAILABLE', '重定向缺少目标地址');
      let next: string;
      try {
        next = new URL(location, url).href;
        if (!/^https?:/i.test(next)) throw new Error('bad protocol');
      } catch {
        throw new AppError('VIDEO_UNAVAILABLE', '重定向目标地址无效');
      }
      // 跨源重定向时丢弃可能泄露凭据的自定义请求头
      let nextHeaders = extraHeaders;
      try {
        if (new URL(next).origin !== new URL(url).origin) {
          nextHeaders = {};
          for (const [k, v] of Object.entries(extraHeaders)) {
            if (!SENSITIVE_HEADERS.includes(k.toLowerCase())) nextHeaders[k] = v;
          }
        }
      } catch {
        // ignore
      }
      await this.httpAttempt(task, ctl, env, offset, redirectCount + 1, next, nextHeaders);
      return;
    }
    if (code === 416) {
      res.resume();
      const partSize = fs.existsSync(env.partPath) ? fs.statSync(env.partPath).size : 0;
      if (task.totalBytes > 0 && offset === task.totalBytes && partSize === offset) {
        this.completeHttp(task, env.finalPath, offset, task.totalBytes);
        return;
      }
      if (offset === 0) {
        // 没有发送 Range 却收到 416：服务器行为异常，避免无限重试
        throw new AppError('VIDEO_UNAVAILABLE', '服务器拒绝下载请求（HTTP 416）');
      }
      // 范围无效或本地片段异常：清空后从头下载
      try {
        if (fs.existsSync(env.partPath)) fs.unlinkSync(env.partPath);
      } catch {
        // ignore
      }
      await this.httpAttempt(task, ctl, env, 0, redirectCount, url, extraHeaders);
      return;
    }
    if (code !== 200 && code !== 206) {
      res.resume();
      if (code === 404 || code === 410) throw new AppError('VIDEO_NOT_FOUND');
      if (code === 401 || code === 403) {
        throw new AppError('AUTH_REQUIRED', `该视频需要登录或存在访问控制，无法下载（HTTP ${code}）`);
      }
      if (code === 429) {
        throw new AppError('VIDEO_UNAVAILABLE', '请求过于频繁（HTTP 429），请稍后重试');
      }
      if (code >= 500) {
        throw new AppError('VIDEO_UNAVAILABLE', `目标服务器暂时不可用（HTTP ${code}）`);
      }
      throw new AppError('VIDEO_UNAVAILABLE', `视频资源不可访问（HTTP ${code}）`);
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      res.destroy();
      throw new AppError('UNSUPPORTED_PLATFORM', '该链接不是可直接下载的视频文件');
    }
    const contentLength = Number(res.headers['content-length'] ?? '0') || 0;
    let newOffset = offset;
    if (code === 200) {
      newOffset = 0;
      try {
        if (fs.existsSync(env.partPath)) fs.unlinkSync(env.partPath);
      } catch {
        // ignore
      }
    }
    let totalBytes = task.totalBytes;
    let expectedBytes = contentLength;
    let totalFromServer = false;
    if (code === 206) {
      // 校验服务器返回的区间起点，防止错误区间导致文件内容错位
      const range = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(res.headers['content-range'] ?? ''));
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start !== newOffset) {
          res.destroy();
          if (newOffset === 0) {
            throw new AppError('VIDEO_UNAVAILABLE', '服务器返回了无效的分段响应');
          }
          try {
            if (fs.existsSync(env.partPath)) fs.unlinkSync(env.partPath);
          } catch {
            // ignore
          }
          await this.httpAttempt(task, ctl, env, 0, redirectCount, url, extraHeaders);
          return;
        }
        if (range[3] !== '*') {
          totalBytes = Number(range[3]) || totalBytes;
          totalFromServer = true;
        }
        if (Number.isFinite(end) && end >= start) expectedBytes = end - start + 1;
      } else if (contentLength > 0) {
        totalBytes = newOffset + contentLength;
        totalFromServer = true;
      }
    } else if (code === 200 && contentLength > 0) {
      totalBytes = contentLength;
      totalFromServer = true;
    }
    if (totalBytes > 0) {
      const free = freeDiskBytes(path.dirname(env.finalPath));
      if (free !== null && totalBytes - newOffset > free) {
        res.destroy();
        throw new AppError('DISK_FULL');
      }
    }

    const stream = fs.createWriteStream(env.partPath, { flags: newOffset > 0 ? 'a' : 'w' });
    // 始终挂一个 error 监听器，避免写入错误在监听器切换的空窗期变成未捕获异常
    let streamError: NodeJS.ErrnoException | null = null;
    stream.on('error', (err: NodeJS.ErrnoException) => {
      streamError = err;
    });
    const assertWritable = () => {
      if (streamError) throw writeAppError(streamError);
    };
    const st = {
      lastTick: Date.now(),
      tickBytes: 0,
      speed: 0,
      windowStart: Date.now(),
      windowBytes: 0,
      lastDataAt: Date.now(),
    };
    let written = 0;
    const stallTimer = setInterval(() => {
      if (Date.now() - st.lastDataAt > env.timeoutMs) {
        try {
          res.destroy(new Error('vdm-stall'));
        } catch {
          // ignore
        }
      }
    }, 1000);

    try {
      for await (const chunk of res) {
        st.lastDataAt = Date.now();
        const buf = chunk as Buffer;
        if (ctl.cancelRequested) {
          res.destroy();
          await endStream(stream);
          throw new JobAbort('cancelled');
        }
        if (ctl.pauseRequested) {
          res.destroy();
          await endStream(stream);
          this.persistProgress(task.id, newOffset + written, totalBytes, 0, 0);
          throw new JobAbort('paused');
        }
        await writeChunk(stream, buf);
        assertWritable();
        written += buf.length;
        st.tickBytes += buf.length;

        if (env.limitBps > 0) {
          st.windowBytes += buf.length;
          const elapsed = Date.now() - st.windowStart;
          const allowed = (env.limitBps * elapsed) / 1000;
          if (st.windowBytes > allowed) {
            const delay = ((st.windowBytes - allowed) / env.limitBps) * 1000;
            res.pause();
            await sleepTouching(st, delay);
            res.resume();
          }
          if (elapsed >= 1000) {
            st.windowStart = Date.now();
            st.windowBytes = 0;
          }
        }

        const now = Date.now();
        if (now - st.lastTick >= 500) {
          const dt = Math.max(0.1, (now - st.lastTick) / 1000);
          const inst = st.tickBytes / dt;
          st.speed = st.speed > 0 ? st.speed * 0.6 + inst * 0.4 : inst;
          const eta =
            st.speed > 0 && totalBytes > 0
              ? Math.round((totalBytes - newOffset - written) / st.speed)
              : 0;
          st.lastTick = now;
          st.tickBytes = 0;
          this.persistProgress(task.id, newOffset + written, totalBytes, Math.round(st.speed), eta);
        }
      }
    } catch (e) {
      try {
        stream.destroy();
      } catch {
        // ignore
      }
      if (e instanceof JobAbort || e instanceof AppError) throw e;
      const stalled = Date.now() - st.lastDataAt > env.timeoutMs * 0.8;
      throw stalled ? new AppError('TIMEOUT') : new AppError('NETWORK_ERROR');
    } finally {
      clearInterval(stallTimer);
    }

    await endStream(stream);
    assertWritable();

    // 完整性校验：连接被对端提前关闭或只返回了部分分段时，绝不能标记为完成
    if (expectedBytes > 0 && written !== expectedBytes) {
      throw new AppError('NETWORK_ERROR', '连接中断，下载数据不完整');
    }
    if (totalFromServer && newOffset + written !== totalBytes) {
      throw new AppError('NETWORK_ERROR', '下载数据不完整（服务器只返回了部分内容）');
    }
    if (!totalFromServer && expectedBytes === 0 && task.totalBytes > 0 && newOffset + written !== task.totalBytes) {
      throw new AppError('NETWORK_ERROR', '连接中断，下载数据不完整');
    }

    if (ctl.cancelRequested) throw new JobAbort('cancelled');
    if (ctl.pauseRequested) {
      this.persistProgress(task.id, newOffset + written, totalBytes, 0, 0);
      throw new JobAbort('paused');
    }
    // 用户在最后时刻取消/删除任务时不要写入完成状态
    const cur = getTask(this.db, task.id);
    if (!cur || cur.status === 'cancelled' || cur.status === 'paused') {
      throw new JobAbort(cur?.status === 'paused' ? 'paused' : 'cancelled');
    }
    this.persistProgress(task.id, newOffset + written, totalBytes, 0, 0);
    this.completeHttp(task, env.finalPath, newOffset + written, totalBytes);
  }

  private persistProgress(
    id: string,
    downloaded: number,
    total: number,
    speed: number,
    eta: number,
  ): void {
    updateTask(this.db, id, {
      downloadedBytes: downloaded,
      totalBytes: total,
      speedBps: speed,
      etaSec: eta,
    });
  }

  private completeHttp(task: TaskRow, finalPath: string, size: number, totalBytes: number): void {
    const partPath = `${finalPath}.part`;
    if (!fs.existsSync(partPath)) {
      throw new AppError('WRITE_ERROR', '部分文件不存在，无法完成下载');
    }
    try {
      try {
        fs.renameSync(partPath, finalPath);
      } catch {
        // Windows 下目标已存在时 rename 失败：先移除旧文件再重试一次
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.renameSync(partPath, finalPath);
      }
    } catch (e) {
      throw new AppError('WRITE_ERROR', `文件保存失败（${(e as NodeJS.ErrnoException).code ?? 'rename'}）`);
    }
    updateTask(this.db, task.id, {
      status: 'completed',
      downloadedBytes: size,
      totalBytes: totalBytes > 0 ? totalBytes : size,
      speedBps: 0,
      etaSec: 0,
      filePath: finalPath,
      completedAt: Date.now(),
      errorCode: '',
      errorMessage: '',
    });
    log.info(`任务 ${task.id} 下载完成：${finalPath}（${size} 字节）`);
  }

  private removePartFile(task: TaskRow): void {
    try {
      const p = `${this.buildHttpPath(task)}.part`;
      this.removeFileEventually(p);
    } catch {
      // ignore
    }
  }

  // ============ yt-dlp 下载（子进程 + 文件大小轮询） ============

  private outputPrefix(task: TaskRow): string {
    // 关键：加入任务短 ID，避免同标题/同清晰度的多个任务互相覆盖或误删文件
    const title = safeFileName(task.title || 'video');
    const formatId = safeFileName(task.formatId || 'na', 'na').slice(0, 40);
    return `${title} [${formatId}] [${task.id.slice(0, 6)}]`;
  }

  private findOutput(dir: string, prefix: string): { size: number; isFinal: boolean; file: string } {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return { size: 0, isFinal: false, file: '' };
    }
    let part: { size: number; file: string } | null = null;
    let final: { size: number; file: string } | null = null;
    for (const f of entries) {
      if (!f.startsWith(prefix)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (f.endsWith('.part')) {
          if (!part || st.size > part.size) part = { size: st.size, file: full };
        } else if (KNOWN_EXTS.some((e) => f.toLowerCase().endsWith(`.${e}`))) {
          if (!final || st.size > final.size) final = { size: st.size, file: full };
        }
      } catch {
        // ignore
      }
    }
    if (final) return { size: final.size, isFinal: true, file: final.file };
    if (part) return { size: part.size, isFinal: false, file: part.file };
    return { size: 0, isFinal: false, file: '' };
  }

  private async runYtdlpJob(task: TaskRow, ctl: JobControl): Promise<void> {
    const settings = this.getSettings();
    const runner = findYtdlp();
    if (!runner) throw new AppError('YTDLP_MISSING');
    const ffmpeg = hasFfmpeg();
    if (task.format === 'mp3' && !ffmpeg) {
      throw new AppError('YTDLP_MISSING', '转换为 MP3 需要 ffmpeg，请安装 ffmpeg 后重试');
    }
    ensureDir(task.folder);
    // yt-dlp 自身不做磁盘预检；已知文件大小时提前拦截，避免下到一半才 ENOSPC
    if (task.totalBytes > 0) {
      const free = freeDiskBytes(task.folder);
      if (free !== null && task.totalBytes > free) {
        throw new AppError('DISK_FULL');
      }
    }
    const selector = buildFormatSelector(task.quality, task.format, ffmpeg);
    const outTemplate = path.join(task.folder, `${this.outputPrefix(task)}.%(ext)s`);
    const args: string[] = [
      ...runner.argsPrefix,
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-f',
      selector,
      '--socket-timeout',
      String(settings.timeoutSec),
      '--retries',
      '1',
      '-o',
      outTemplate,
    ];
    if (settings.proxyUrl) args.push('--proxy', settings.proxyUrl);
    if (settings.maxSpeedKBps > 0) args.push('--limit-rate', `${Math.round(settings.maxSpeedKBps)}K`);
    const cookiesFile = task.cookiesFile || settings.cookiesFile;
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      args.push('--cookies', cookiesFile);
    }
    if (task.ytdlpArgs) {
      for (const line of task.ytdlpArgs.split(/\r?\n/)) {
        const a = line.trim();
        if (a) args.push(a);
      }
    }
    if (task.headers) {
      try {
        const h = JSON.parse(task.headers) as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          if (k && v && !/[\r\n]/.test(k) && !/[\r\n]/.test(String(v))) {
            args.push('--add-headers', `${k}:${v}`);
          }
        }
      } catch {
        // ignore
      }
    }
    if (ffmpeg && fs.existsSync(config.ffmpegPath)) {
      args.push('--ffmpeg-location', path.dirname(config.ffmpegPath));
    }
    if (task.format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (task.format === 'm4a' && ffmpeg) {
      args.push('-x', '--audio-format', 'm4a');
    }
    args.push(task.url);

    const logFile = path.join(config.dataDir, 'logs', `${task.id}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    const prefix = this.outputPrefix(task);
    const initial = this.findOutput(task.folder, prefix);
    updateTask(this.db, task.id, {
      status: 'downloading',
      downloadedBytes: initial.size,
      startedAt: task.startedAt ?? Date.now(),
      errorCode: '',
      errorMessage: '',
    });

    let proc: ChildProcess;
    try {
      proc = spawn(runner.cmd, args, {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: ytdlpEnv(),
      });
    } catch (e) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      throw new AppError('YTDLP_MISSING', `无法启动 yt-dlp（${(e as NodeJS.ErrnoException).message}）`);
    }
    ctl.proc = proc;

    const exitPromise = new Promise<number>((resolve, reject) => {
      proc.on('error', (e: NodeJS.ErrnoException) => {
        reject(
          e.code === 'ENOENT'
            ? new AppError('YTDLP_MISSING')
            : new AppError('NETWORK_ERROR', `yt-dlp 启动失败（${e.code ?? e.message}）`),
        );
      });
      proc.on('exit', (code) => resolve(code ?? 1));
    });

    let lastSize = initial.size;
    let lastTick = Date.now();
    let tickBytes = 0;
    let speed = 0;
    let lastChangeAt = Date.now();
    let lastLogSize = 0;
    let killedForStall = false;
    const stallLimit = Math.max(120_000, settings.timeoutSec * 3000);
    let pollTimer: NodeJS.Timeout | undefined;
    let code = 1;
    try {
      pollTimer = setInterval(() => {
        const cur = this.findOutput(task.folder, prefix);
        if (cur.size !== lastSize) {
          const delta = Math.max(0, cur.size - lastSize);
          tickBytes += delta;
          lastSize = cur.size;
          lastChangeAt = Date.now();
        }
        // yt-dlp 在解析/合并阶段可能暂时不写文件，用日志变化作为“仍存活”信号
        let logSize = 0;
        try {
          logSize = fs.statSync(logFile).size;
        } catch {
          // ignore
        }
        if (logSize !== lastLogSize) {
          lastLogSize = logSize;
          lastChangeAt = Date.now();
        }
        const now = Date.now();
        if (now - lastTick >= 1000) {
          const dt = Math.max(0.1, (now - lastTick) / 1000);
          const inst = tickBytes / dt;
          speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
          const total = task.totalBytes;
          const eta = speed > 0 && total > 0 ? Math.round((total - lastSize) / speed) : 0;
          updateTask(this.db, task.id, {
            downloadedBytes: lastSize,
            totalBytes: total,
            speedBps: Math.round(speed),
            etaSec: eta,
          });
          tickBytes = 0;
          lastTick = now;
        }
        if (ctl.cancelRequested || ctl.pauseRequested) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
        // 长时间无任何进度（文件与日志都不再变化）→ 判定卡死
        if (Date.now() - lastChangeAt > stallLimit) {
          killedForStall = true;
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
      }, 500);
      code = await exitPromise;
    } finally {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }

    if (ctl.cancelRequested) {
      this.removeYtdlpFiles(task, prefix, 'all');
      updateTask(this.db, task.id, {
        status: 'cancelled',
        speedBps: 0,
        etaSec: 0,
        downloadedBytes: 0,
        errorCode: 'CANCELLED',
        errorMessage: '任务已取消',
      });
      return;
    }
    if (ctl.pauseRequested) {
      const cur = this.findOutput(task.folder, prefix);
      updateTask(this.db, task.id, {
        status: this.shuttingDown ? 'downloading' : 'paused',
        speedBps: 0,
        etaSec: 0,
        downloadedBytes: cur.size,
      });
      return;
    }
    if (code !== 0) {
      const cur = this.findOutput(task.folder, prefix);
      if (cur.size > 0) {
        updateTask(this.db, task.id, { downloadedBytes: cur.size, speedBps: 0, etaSec: 0 });
      }
      if (killedForStall) throw new AppError('TIMEOUT', '下载长时间无进展，已自动中断');
      throw mapYtdlpError(tailOfFile(logFile));
    }
    const cur = this.findOutput(task.folder, prefix);
    if (!cur.file || !cur.isFinal) {
      throw new AppError('WRITE_ERROR', '下载完成但未找到输出文件');
    }
    const size = cur.size > 0 ? cur.size : fs.statSync(cur.file).size;
    updateTask(this.db, task.id, {
      status: 'completed',
      downloadedBytes: size,
      totalBytes: size,
      speedBps: 0,
      etaSec: 0,
      filePath: cur.file,
      completedAt: Date.now(),
      errorCode: '',
      errorMessage: '',
    });
    log.info(`任务 ${task.id} 下载完成：${cur.file}（${size} 字节）`);
  }

  private removeYtdlpFiles(task: TaskRow, prefix: string, mode: 'all' | 'temps'): void {
    this.removeYtdlpFilesWithPrefix(task.folder, prefix, mode);
  }

  private removeYtdlpFilesWithPrefix(folder: string, prefix: string, mode: 'all' | 'temps'): void {
    try {
      for (const f of fs.readdirSync(folder)) {
        if (!f.startsWith(prefix)) continue;
        if (mode === 'temps' && !/\.(part|ytdl|temp)$/i.test(f) && !/\.f\d+\.[a-z0-9]+$/i.test(f)) continue;
        const full = path.join(folder, f);
        try {
          if (fs.statSync(full).isFile()) fs.unlinkSync(full);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
}

/** 限速睡眠期间持续刷新“活跃时间”，避免把主动限速误判为网络卡死 */
async function sleepTouching(st: { lastDataAt: number }, ms: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    st.lastDataAt = Date.now();
    await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
  st.lastDataAt = Date.now();
}

function writeAppError(err: NodeJS.ErrnoException): AppError {
  return err.code === 'ENOSPC'
    ? new AppError('DISK_FULL')
    : new AppError('WRITE_ERROR', `写入文件失败（${err.code ?? err.message}）`);
}

function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(writeAppError(err));
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.removeListener('error', onErr);
      stream.removeListener('drain', onDrain);
    };
    stream.once('error', onErr);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => {
      reject(writeAppError(err));
    };
    stream.once('error', onErr);
    stream.end(() => {
      stream.removeListener('error', onErr);
      resolve();
    });
  });
}
