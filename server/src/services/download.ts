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
}

const KNOWN_EXTS = ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'mov', 'm4v', 'avi', 'flv', 'ts'];

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

  /** 执行一个任务（不抛错；所有异常转为任务失败/暂停/取消状态） */
  async runJob(id: string): Promise<void> {
    const task = getTask(this.db, id);
    if (!task) return;
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
    log.info(`任务 ${id} 暂停请求`);
    return true;
  }

  /** 取消任务（含等待中的任务统一由队列层处理，这里处理运行中的） */
  cancel(id: string): boolean {
    const ctl = this.jobs.get(id);
    if (!ctl) return false;
    ctl.cancelRequested = true;
    updateTask(this.db, id, { status: 'cancelled', speedBps: 0, etaSec: 0, downloadedBytes: 0 });
    log.info(`任务 ${id} 取消请求`);
    return true;
  }

  abortAll(): void {
    this.shuttingDown = true;
    for (const ctl of this.jobs.values()) {
      ctl.pauseRequested = true;
      try {
        ctl.req?.destroy();
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

  private async handleJobError(task: TaskRow, e: unknown): Promise<void> {
    if (e instanceof JobAbort) {
      // 仅在任务仍处于运行状态时才写入终态，避免覆盖用户后续的暂停/继续/取消操作
      const cur = getTask(this.db, task.id);
      if (e.kind === 'cancelled') {
        this.removePartFile(task);
        if (cur && ['downloading', 'parsing', 'waiting', 'paused'].includes(cur.status)) {
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
        // 服务关闭中：保留 downloading 状态，重启后自动恢复
        if (cur && ['downloading', 'parsing'].includes(cur.status)) {
          updateTask(this.db, task.id, { status: 'downloading', speedBps: 0, etaSec: 0 });
        }
      } else if (cur && ['downloading', 'parsing'].includes(cur.status)) {
        updateTask(this.db, task.id, { status: 'paused', speedBps: 0, etaSec: 0 });
      }
      return;
    }
    const appErr = isAppError(e) ? e : new AppError('INTERNAL', '任务异常退出，请重试');
    const settings = this.getSettings();
    if (task.retryCount < settings.autoRetries) {
      const n = task.retryCount + 1;
      updateTask(this.db, task.id, {
        status: 'waiting',
        speedBps: 0,
        etaSec: 0,
        retryCount: n,
        errorCode: appErr.code,
        errorMessage: `${appErr.message}（自动重试 ${n}/${settings.autoRetries}）`,
      });
      this.getQueue().enqueue(task.id, { front: true });
      return;
    }
    updateTask(this.db, task.id, {
      status: 'failed',
      speedBps: 0,
      etaSec: 0,
      errorCode: appErr.code,
      errorMessage: appErr.message,
    });
    log.warn(`任务 ${task.id} 失败：${appErr.code} ${appErr.message}`);
  }

  // ============ HTTP 直链下载（支持断点续传 / 限速 / 暂停 / 取消） ============

  private buildHttpPath(task: TaskRow): string {
    const ext = (task.format || 'mp4').toLowerCase().replace(/^\./, '');
    let base = safeFileName(task.title || 'video');
    if (!base.toLowerCase().endsWith(`.${ext}`)) base += `.${ext}`;
    const stem = base.slice(0, base.length - ext.length - 1);
    return path.join(task.folder, `${stem} [${task.id.slice(0, 6)}].${ext}`);
  }

  private async runHttpJob(task: TaskRow, ctl: JobControl): Promise<void> {
    const settings = this.getSettings();
    const finalPath = this.buildHttpPath(task);
    const partPath = `${finalPath}.part`;
    ensureDir(path.dirname(finalPath));
    // 自定义解析源可能给出真实下载地址与附加请求头
    const url = task.resolvedUrl || task.url;
    const extraHeaders: http.OutgoingHttpHeaders = {};
    try {
      const parsed = JSON.parse(task.headers || '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v) extraHeaders[k] = v;
        }
      }
    } catch {
      // ignore
    }
    let offset = task.downloadedBytes;
    if (fs.existsSync(partPath)) {
      const partSize = fs.statSync(partPath).size;
      offset = Math.min(offset || partSize, partSize);
    } else {
      offset = 0;
    }
    if (offset === 0 && fs.existsSync(partPath)) {
      try {
        fs.unlinkSync(partPath);
      } catch {
        // ignore
      }
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
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers: http.OutgoingHttpHeaders = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      ...extraHeaders,
    };
    if (offset > 0) headers.range = `bytes=${offset}-`;
    const req = mod.get(u, { headers, timeout: env.timeoutMs });
    ctl.req = req;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
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
        const msg = String(e?.message ?? '');
        if (msg.includes('vdm-timeout')) settleErr(new AppError('TIMEOUT'));
        else settleErr(new AppError('NETWORK_ERROR', `网络连接中断（${e?.code ?? 'unknown'}）`));
      });
      req.on('response', (res) => {
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
      if (!res.headers.location) throw new AppError('VIDEO_UNAVAILABLE', '重定向缺少目标地址');
      const next = new URL(res.headers.location, url).href;
      await this.httpAttempt(task, ctl, env, offset, redirectCount + 1, next, extraHeaders);
      return;
    }
    if (code === 416) {
      res.resume();
      if (task.totalBytes > 0 && offset >= task.totalBytes) {
        this.completeHttp(task, env.finalPath, offset, task.totalBytes);
        return;
      }
      await this.httpAttempt(task, ctl, env, 0, redirectCount, url, extraHeaders);
      return;
    }
    if (code !== 200 && code !== 206) {
      res.resume();
      if (code === 404) throw new AppError('VIDEO_NOT_FOUND');
      if (code === 401 || code === 403) throw new AppError('VIDEO_UNAVAILABLE', '视频资源不可访问（HTTP 403）');
      throw new AppError('VIDEO_UNAVAILABLE', `视频资源不可访问（HTTP ${code}）`);
    }
    const contentType = String(res.headers['content-type'] ?? '');
    const contentLength = Number(res.headers['content-length'] ?? '0') || 0;
    let newOffset = offset;
    if (code === 200) {
      if (contentType.startsWith('text/html')) {
        res.destroy();
        throw new AppError('UNSUPPORTED_PLATFORM', '该链接不是可直接下载的视频文件');
      }
      newOffset = 0;
      try {
        if (fs.existsSync(env.partPath)) fs.unlinkSync(env.partPath);
      } catch {
        // ignore
      }
    }
    let totalBytes = task.totalBytes;
    if (code === 206 && contentLength > 0) totalBytes = newOffset + contentLength;
    else if (code === 200 && contentLength > 0) totalBytes = contentLength;
    if (totalBytes > 0) {
      const free = freeDiskBytes(path.dirname(env.finalPath));
      if (free !== null && totalBytes - newOffset > free) {
        res.destroy();
        throw new AppError('DISK_FULL');
      }
    }

    const stream = fs.createWriteStream(env.partPath, { flags: newOffset > 0 ? 'a' : 'w' });
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
        written += buf.length;

        if (env.limitBps > 0) {
          st.windowBytes += buf.length;
          const elapsed = Date.now() - st.windowStart;
          const allowed = (env.limitBps * elapsed) / 1000;
          if (st.windowBytes > allowed) {
            const delay = ((st.windowBytes - allowed) / env.limitBps) * 1000;
            res.pause();
            await sleep(delay);
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
          const eta = st.speed > 0 && totalBytes > 0 ? Math.round((totalBytes - newOffset - written) / st.speed) : 0;
          st.lastTick = now;
          st.tickBytes = 0;
          this.persistProgress(task.id, newOffset + written, totalBytes, Math.round(st.speed), eta);
        } else {
          st.tickBytes += buf.length;
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
    this.persistProgress(task.id, newOffset + written, totalBytes, 0, 0);
    this.completeHttp(task, env.finalPath, newOffset + written, totalBytes);
  }

  private persistProgress(id: string, downloaded: number, total: number, speed: number, eta: number): void {
    updateTask(this.db, id, {
      downloadedBytes: downloaded,
      totalBytes: total,
      speedBps: speed,
      etaSec: eta,
    });
  }

  private completeHttp(task: TaskRow, finalPath: string, size: number, totalBytes: number): void {
    try {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      fs.renameSync(`${finalPath}.part`, finalPath);
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
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }

  // ============ yt-dlp 下载（子进程 + 文件大小轮询） ============

  private outputPrefix(task: TaskRow): string {
    const extSafe = safeFileName(task.title || 'video');
    return `${extSafe} [${task.formatId}]`;
  }

  private findOutput(
    dir: string,
    prefix: string,
  ): { size: number; isFinal: boolean; file: string } {
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
          if (k && v) args.push('--add-headers', `${k}:${v}`);
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
    const stallLimit = settings.timeoutSec * 2000;
    const pollTimer = setInterval(() => {
      const cur = this.findOutput(task.folder, prefix);
      if (cur.size !== lastSize) {
        const delta = Math.max(0, cur.size - lastSize);
        tickBytes += delta;
        lastSize = cur.size;
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
      // 长时间无任何数据且任务还在下载 → 判定卡死
      if (Date.now() - lastChangeAt > stallLimit && lastSize > 0) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    }, 500);

    const code = await exitPromise;
    clearInterval(pollTimer);
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }

    if (ctl.cancelRequested) {
      this.cleanupYtdlpFiles(task, prefix);
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

  private cleanupYtdlpFiles(task: TaskRow, prefix: string): void {
    try {
      for (const f of fs.readdirSync(task.folder)) {
        if (!f.startsWith(prefix)) continue;
        const full = path.join(task.folder, f);
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

function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOSPC' ? new AppError('DISK_FULL') : new AppError('WRITE_ERROR', `写入文件失败（${err.code}）`));
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
    stream.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOSPC' ? new AppError('DISK_FULL') : new AppError('WRITE_ERROR', `写入文件失败（${err.code}）`));
    });
    stream.end(() => resolve());
  });
}
