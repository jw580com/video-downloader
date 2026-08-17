import type { DB } from './database.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';

export interface Settings {
  downloadQuality: string;
  downloadFormat: string;
  maxConcurrency: number;
  downloadDir: string;
  maxSpeedKBps: number;
  timeoutSec: number;
  autoRetries: number;
  cookiesFile: string;
}

export const CONCURRENCY_OPTIONS = [1, 2, 3, 5, 10] as const;
export const QUALITY_OPTIONS = ['best', '2160', '1440', '1080', '720', '480', '360'] as const;
export const FORMAT_OPTIONS = ['mp4', 'webm', 'mkv', 'm4a', 'mp3'] as const;

const DEFAULTS: Settings = {
  downloadQuality: 'best',
  downloadFormat: 'mp4',
  maxConcurrency: (() => {
    const env = Number(process.env.MAX_CONCURRENCY);
    return (CONCURRENCY_OPTIONS as readonly number[]).includes(env) ? env : 3;
  })(),
  downloadDir: config.defaultDownloadDir,
  maxSpeedKBps: 0,
  timeoutSec: 60,
  autoRetries: 2,
  cookiesFile: '',
};

export function getSettings(db: DB): Settings {
  const stored = new Map<string, string>();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  for (const r of rows) stored.set(r.key, r.value);
  const out: Settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as Array<keyof Settings>) {
    const raw = stored.get(k);
    if (raw === undefined) continue;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === typeof out[k]) (out as unknown as Record<string, unknown>)[k] = v;
    } catch {
      // 忽略损坏的配置项
    }
  }
  return out;
}

export function validateSettings(partial: Partial<Settings>): void {
  if (
    partial.maxConcurrency !== undefined &&
    !(CONCURRENCY_OPTIONS as readonly number[]).includes(partial.maxConcurrency)
  ) {
    throw new AppError('BAD_REQUEST', '最大并发任务数只能是 1 / 2 / 3 / 5 / 10');
  }
  if (
    partial.maxSpeedKBps !== undefined &&
    (!Number.isFinite(partial.maxSpeedKBps) || partial.maxSpeedKBps < 0 || partial.maxSpeedKBps > 1048576)
  ) {
    throw new AppError('BAD_REQUEST', '最大下载速度超出允许范围（0 ~ 1048576 KB/s）');
  }
  if (
    partial.timeoutSec !== undefined &&
    (!Number.isFinite(partial.timeoutSec) || partial.timeoutSec < 5 || partial.timeoutSec > 600)
  ) {
    throw new AppError('BAD_REQUEST', '请求超时时间应在 5 ~ 600 秒之间');
  }
  if (
    partial.autoRetries !== undefined &&
    (!Number.isInteger(partial.autoRetries) || partial.autoRetries < 0 || partial.autoRetries > 10)
  ) {
    throw new AppError('BAD_REQUEST', '自动重试次数应在 0 ~ 10 之间');
  }
  if (partial.downloadQuality !== undefined && !(QUALITY_OPTIONS as readonly string[]).includes(partial.downloadQuality)) {
    throw new AppError('BAD_REQUEST', '默认下载质量无效');
  }
  if (partial.downloadFormat !== undefined && !(FORMAT_OPTIONS as readonly string[]).includes(partial.downloadFormat)) {
    throw new AppError('BAD_REQUEST', '默认文件格式无效');
  }
  if (partial.downloadDir !== undefined && (typeof partial.downloadDir !== 'string' || partial.downloadDir.trim() === '')) {
    throw new AppError('BAD_REQUEST', '默认保存目录不能为空');
  }
  if (partial.cookiesFile !== undefined && typeof partial.cookiesFile !== 'string') {
    throw new AppError('BAD_REQUEST', 'Cookie 文件路径无效');
  }
}

export function updateSettings(db: DB, partial: Partial<Settings>): Settings {
  validateSettings(partial);
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue;
    upsert.run(k, JSON.stringify(v));
  }
  return getSettings(db);
}
