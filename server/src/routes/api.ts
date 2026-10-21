import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db/database.js';
import { getSettings, updateSettings, type Settings } from '../db/settings.js';
import { getAllStats, getPlatformOptions } from '../db/stats.js';
import {
  ALL_STATUSES,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  listTaskIds,
  clearFilePath,
  type TaskStatus,
} from '../db/tasks.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { clamp, resolveFolder } from '../util.js';
import { parseVideo, type VideoInfo } from '../services/metadata.js';
import { detectPlatform, normalizeUrl, PLATFORM_NAMES } from '../services/platforms.js';
import type { TaskQueue } from '../services/queue.js';
import { getSystemInfo } from '../services/system.js';
import {
  createParser,
  deleteParser,
  getParser,
  listParsers,
  updateParser,
  type NewParser,
  type ParserType,
} from '../db/parsers.js';

export interface RouterDeps {
  db: DB;
  queue: TaskQueue;
  getSettingsFn: () => Settings;
  refreshSettings: () => void;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const VALID_SORTS = ['created_at', 'updated_at', 'completed_at', 'total_bytes'];

function fallbackTitle(url: string, platform: string): string {
  return `${PLATFORM_NAMES[platform as keyof typeof PLATFORM_NAMES] ?? '视频'} 视频`;
}

/** 校验自定义解析源的请求体，返回规范化后的字段 */
function validateParserBody(
  body: Record<string, unknown>,
  fallback: NewParser | null,
): NewParser {
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : fallback?.name ?? '';
  if (!name) throw new AppError('BAD_REQUEST', '解析源名称不能为空');
  const domains =
    typeof body.domains === 'string' && body.domains.trim()
      ? body.domains.trim().slice(0, 500)
      : fallback?.domains ?? '';
  if (!domains) throw new AppError('BAD_REQUEST', '域名不能为空（逗号分隔，如 weibo.com,weibo.cn）');
  const typeRaw = typeof body.type === 'string' ? body.type : fallback?.type ?? 'ytdlp';
  if (typeRaw !== 'ytdlp' && typeRaw !== 'script') {
    throw new AppError('BAD_REQUEST', '解析源类型必须是 ytdlp 或 script');
  }
  const type = typeRaw as ParserType;
  const script =
    typeof body.script === 'string' ? body.script.trim().slice(0, 4000) : fallback?.script ?? '';
  if (type === 'script' && !script) {
    throw new AppError('BAD_REQUEST', '脚本型解析源必须填写脚本命令');
  }
  let headers = typeof body.headers === 'string' ? body.headers.trim() : fallback?.headers ?? '';
  if (headers) {
    try {
      const parsed = JSON.parse(headers);
      if (!parsed || typeof parsed !== 'object') throw new Error('not object');
    } catch {
      throw new AppError('BAD_REQUEST', '请求头必须是合法 JSON 对象，如 {"Referer":"https://example.com"}');
    }
  }
  return {
    name,
    domains,
    type,
    enabled:
      body.enabled !== undefined ? body.enabled === true : fallback?.enabled ?? true,
    ytdlpArgs:
      typeof body.ytdlpArgs === 'string'
        ? body.ytdlpArgs.slice(0, 4000)
        : fallback?.ytdlpArgs ?? '',
    headers,
    script,
    cookiesFile:
      typeof body.cookiesFile === 'string'
        ? body.cookiesFile.trim().slice(0, 1000)
        : fallback?.cookiesFile ?? '',
  };
}

function openInFileManager(filePath: string): { ok: boolean; message: string } {
  const dir = path.dirname(filePath);
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', ['/select,', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, message: '已在文件管理器中打开' };
  } catch {
    return { ok: false, message: `无法打开文件管理器，文件路径：${filePath}` };
  }
}

/** 质量/格式白名单校验：避免任意字符串进入文件名或 yt-dlp 选择器 */
function normalizeTaskOptions(rawQuality: unknown, rawFormat: unknown, fallbackQuality: string, fallbackFormat: string): { quality: string; format: string } {
  const quality = typeof rawQuality === 'string' && rawQuality.trim() ? rawQuality.trim() : fallbackQuality;
  if (!/^(best|original|\d{3,4})$/.test(quality)) {
    throw new AppError('BAD_REQUEST', '视频质量参数无效');
  }
  if (/^\d{3,4}$/.test(quality) && (Number(quality) < 144 || Number(quality) > 4320)) {
    throw new AppError('BAD_REQUEST', '视频质量参数超出范围');
  }
  const format = (typeof rawFormat === 'string' && rawFormat.trim() ? rawFormat.trim() : fallbackFormat).toLowerCase();
  // 仅允许安全扩展名，杜绝通过 format 注入路径分隔符（路径穿越）
  if (!/^[a-z0-9]{1,10}$/.test(format)) {
    throw new AppError('BAD_REQUEST', '文件格式参数无效');
  }
  return { quality, format };
}

/** 清洗客户端传入的 formatId，避免其进入 yt-dlp 输出文件名时破坏路径 */
function sanitizeFormatId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\w.-]+/g, '_').slice(0, 60);
}

function normalizeResolvedUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('BAD_REQUEST', '解析出的下载地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', '下载地址必须是 http(s) 链接');
  }
  return value.slice(0, 4096);
}

/** 删除一个任务（运行中的先取消并等待退出；withFiles 时同时删除已下载文件） */
async function removeTaskRecord(
  deps: RouterDeps,
  id: string,
  withFiles: boolean,
): Promise<{ removed: boolean; fileDeleted: boolean; error?: string }> {
  const { db, queue } = deps;
  const task = getTask(db, id);
  if (!task) return { removed: false, fileDeleted: false };
  // 先取消并等待任务真正退出，避免删除记录后引擎仍在写文件/更新数据库
  await queue.cancelAndWait(id);
  let fileDeleted = false;
  const remaining = getTask(db, id);
  if (withFiles && task.filePath) {
    try {
      if (fs.existsSync(task.filePath)) {
        fs.unlinkSync(task.filePath);
        fileDeleted = true;
      }
      const part = `${task.filePath}.part`;
      if (fs.existsSync(part)) fs.unlinkSync(part);
    } catch {
      return {
        removed: false,
        fileDeleted,
        error: `删除文件失败：${task.filePath}`,
      };
    }
  }
  // 无论是否删除正片，都清理临时文件与任务日志，避免留下孤儿文件
  if (remaining) queue.cleanupTaskFiles(remaining);
  queue.cleanupTaskLog(id);
  deleteTask(db, id);
  return { removed: true, fileDeleted };
}


export function createApiRouter(deps: RouterDeps): Router {
  const { db, queue, getSettingsFn, refreshSettings } = deps;
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      version: config.version,
      uptimeSec: Math.round(process.uptime()),
      queue: queue.snapshot(),
    });
  });

  // ---- URL 解析 ----
  router.post(
    '/parse',
    wrap(async (req, res) => {
      const url = (req.body as { url?: unknown })?.url;
      const settings = getSettingsFn();
      const info: VideoInfo = await parseVideo(db, url, settings.cookiesFile, settings.proxyUrl);
      res.json({ info });
    }),
  );

  // ---- 任务 ----
  router.get(
    '/tasks',
    wrap(async (req, res) => {
      const q = req.query;
      const statuses = q.status
        ? String(q.status)
            .split(',')
            .map((s) => s.trim())
            .filter((s): s is TaskStatus => (ALL_STATUSES as string[]).includes(s))
        : undefined;
      const result = listTasks(db, {
        statuses: statuses as TaskStatus[] | undefined,
        platform: q.platform ? String(q.platform) : undefined,
        search: q.search ? String(q.search) : undefined,
        sort: VALID_SORTS.includes(String(q.sort)) ? (String(q.sort) as 'created_at') : 'created_at',
        order: String(q.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC',
        limit: clamp(Number(q.limit) || 50, 1, 500),
        offset: clamp(Number(q.offset) || 0, 0, 1000000),
      });
      res.json(result);
    }),
  );

  router.get(
    '/tasks/:id',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      res.json({ task });
    }),
  );

  router.post(
    '/tasks',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = normalizeUrl(body.url).href;
      const platform = detectPlatform(new URL(url));
      const settings = getSettingsFn();
      const { quality, format } = normalizeTaskOptions(
        body.quality,
        body.format,
        settings.downloadQuality,
        settings.downloadFormat,
      );
      const folderInput =
        typeof body.folder === 'string' && body.folder.trim() !== '' ? body.folder : settings.downloadDir;
      let folder: string;
      try {
        folder = resolveFolder(folderInput);
      } catch {
        throw new AppError('BAD_REQUEST', `保存目录不可用或不可写：${folderInput}`);
      }
      const resolvedUrl = normalizeResolvedUrl(body.resolvedUrl);
      const engine: 'http' | 'ytdlp' =
        body.engine === 'http' || platform === 'direct' || (body.engine !== 'ytdlp' && resolvedUrl !== '')
          ? 'http'
          : 'ytdlp';
      const id = randomUUID();
      const task = createTask(db, {
        id,
        url,
        platform:
          typeof body.platform === 'string' && body.platform
            ? body.platform
            : platform,
        title:
          (typeof body.title === 'string' && body.title.trim().slice(0, 500)) ||
          fallbackTitle(url, platform),
        thumbnail: typeof body.thumbnail === 'string' ? body.thumbnail.slice(0, 2000) : '',
        author: typeof body.author === 'string' ? body.author.slice(0, 300) : '',
        durationSec: clamp(Math.round(Number(body.durationSec) || 0), 0, 604800),
        quality,
        format,
        formatId: sanitizeFormatId(body.formatId),
        engine,
        totalBytes: clamp(Math.round(Number(body.totalBytes) || 0), 0, Number.MAX_SAFE_INTEGER),
        folder,
        resolvedUrl,
        headers:
          body.headers && typeof body.headers === 'object'
            ? JSON.stringify(body.headers).slice(0, 4000)
            : '',
        platformName: typeof body.platformName === 'string' ? body.platformName.slice(0, 100) : '',
        ytdlpArgs: typeof body.ytdlpArgs === 'string' ? body.ytdlpArgs.slice(0, 4000) : '',
        cookiesFile: typeof body.cookiesFile === 'string' ? body.cookiesFile.slice(0, 1000) : '',
      });
      queue.enqueue(id);
      res.status(201).json({ task });
    }),
  );

  router.post(
    '/tasks/:id/pause',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (!['downloading', 'parsing', 'waiting'].includes(task.status)) {
        throw new AppError('BAD_REQUEST', '当前状态无法暂停');
      }
      queue.pause(req.params.id);
      res.json({ task: getTask(db, req.params.id) });
    }),
  );

  router.post(
    '/tasks/:id/resume',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (task.status !== 'paused') throw new AppError('BAD_REQUEST', '只有已暂停的任务可以继续');
      queue.resume(req.params.id);
      res.json({ task: getTask(db, req.params.id) });
    }),
  );

  router.post(
    '/tasks/:id/cancel',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        throw new AppError('BAD_REQUEST', '任务已结束，无法取消');
      }
      queue.cancel(req.params.id);
      res.json({ task: getTask(db, req.params.id) });
    }),
  );

  router.post(
    '/tasks/:id/retry',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (!['failed', 'cancelled'].includes(task.status)) {
        throw new AppError('BAD_REQUEST', '只有失败或已取消的任务可以重试');
      }
      queue.retry(req.params.id);
      res.json({ task: getTask(db, req.params.id) });
    }),
  );

  // 删除任务记录；file=1 时同时删除已下载的文件（二者明确区分）
  router.delete(
    '/tasks/:id',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      const result = await removeTaskRecord(
        deps,
        req.params.id,
        String(req.query.file ?? '') === '1',
      );
      if (!result.removed) {
        throw new AppError('WRITE_ERROR', result.error ?? '删除任务失败');
      }
      res.json({ ok: true, fileDeleted: result.fileDeleted });
    }),
  );

  // 批量删除任务（ids + withFiles）
  router.post(
    '/tasks/batch-delete',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { ids?: unknown; withFiles?: unknown };
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500) {
        throw new AppError('BAD_REQUEST', 'ids 必须为 1~500 个任务 ID 的数组');
      }
      const withFiles = body.withFiles === true;
      let deleted = 0;
      let filesDeleted = 0;
      let failed = 0;
      for (const rawId of body.ids) {
        if (typeof rawId !== 'string') continue;
        const r = await removeTaskRecord(deps, rawId, withFiles);
        if (r.removed) {
          deleted++;
          if (r.fileDeleted) filesDeleted++;
        } else if (r.error) {
          failed++;
        }
      }
      res.json({ ok: failed === 0, deleted, filesDeleted, failed });
    }),
  );

  // 删除全部任务（可选按当前列表的 status/platform/search 筛选条件）
  router.post(
    '/tasks/delete-all',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        withFiles?: unknown;
        status?: unknown;
        platform?: unknown;
        search?: unknown;
      };
      const statusParam = typeof body.status === 'string' ? body.status : '';
      const statuses = statusParam
        ? statusParam
            .split(',')
            .map((s) => s.trim())
            .filter((s): s is TaskStatus => (ALL_STATUSES as string[]).includes(s))
        : undefined;
      const ids = listTaskIds(db, {
        statuses,
        platform: typeof body.platform === 'string' && body.platform ? body.platform : undefined,
        search: typeof body.search === 'string' && body.search ? body.search : undefined,
      });
      const withFiles = body.withFiles === true;
      let deleted = 0;
      let filesDeleted = 0;
      let failed = 0;
      for (const id of ids) {
        const r = await removeTaskRecord(deps, id, withFiles);
        if (r.removed) {
          deleted++;
          if (r.fileDeleted) filesDeleted++;
        } else if (r.error) {
          failed++;
        }
      }
      res.json({ ok: failed === 0, deleted, filesDeleted, failed });
    }),
  );

  // 仅删除已下载的实体文件（保留历史记录）
  router.post(
    '/tasks/:id/delete-file',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (!task.filePath) throw new AppError('NOT_FOUND', '该任务没有已下载的文件');
      let deleted = false;
      try {
        if (fs.existsSync(task.filePath)) {
          fs.unlinkSync(task.filePath);
          deleted = true;
        }
        const part = `${task.filePath}.part`;
        if (fs.existsSync(part)) {
          fs.unlinkSync(part);
          deleted = true;
        }
        queue.cleanupTaskFiles(task);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError('WRITE_ERROR', '删除文件失败');
      }
      clearFilePath(db, req.params.id);
      if (!deleted) throw new AppError('NOT_FOUND', '文件不存在或已被删除');
      res.json({ ok: true });
    }),
  );

  router.post(
    '/tasks/:id/open-folder',
    wrap(async (req, res) => {
      const task = getTask(db, req.params.id);
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (!task.filePath || !fs.existsSync(task.filePath)) {
        throw new AppError('NOT_FOUND', '文件不存在，无法打开');
      }
      res.json(openInFileManager(task.filePath));
    }),
  );

  // ---- 自定义解析源 ----
  router.get('/parsers', (req, res) => {
    res.json({ parsers: listParsers(db) });
  });

  router.post(
    '/parsers',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parser = createParser(db, validateParserBody(body, null));
      res.status(201).json({ parser });
    }),
  );

  router.put(
    '/parsers/:id',
    wrap(async (req, res) => {
      const existing = getParser(db, req.params.id);
      if (!existing) throw new AppError('NOT_FOUND', '解析源不存在');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parser = updateParser(db, req.params.id, validateParserBody(body, existing));
      res.json({ parser });
    }),
  );

  router.delete(
    '/parsers/:id',
    wrap(async (req, res) => {
      if (!getParser(db, req.params.id)) throw new AppError('NOT_FOUND', '解析源不存在');
      deleteParser(db, req.params.id);
      res.json({ ok: true });
    }),
  );

  // ---- 设置 ----
  router.get('/settings', (req, res) => {
    res.json({ settings: getSettingsFn() });
  });

  router.put(
    '/settings',
    wrap(async (req, res) => {
      const partial = (req.body ?? {}) as Partial<Settings>;
      const settings = updateSettings(db, partial);
      refreshSettings();
      queue.onConcurrencyChanged();
      res.json({ settings });
    }),
  );

  // ---- 统计 ----
  router.get('/stats', (req, res) => {
    res.json(getAllStats(db));
  });

  // ---- 平台列表（历史页筛选，含自定义解析源） ----
  router.get('/platforms', (req, res) => {
    res.json({ platforms: getPlatformOptions(db) });
  });

  // ---- 系统信息 ----
  router.get('/system', (req, res) => {
    res.json(getSystemInfo(db, queue, getSettingsFn()));
  });

  return router;
}
