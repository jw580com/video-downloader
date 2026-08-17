import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { ROOT_DIR } from './config.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs(): number {
  return Date.now();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 去除文件名中的非法字符，限制长度 */
export function safeFileName(name: string, fallback = 'video'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const limited = cleaned.slice(0, 120).trim();
  return limited || fallback;
}

/** 确保目录存在且可写 */
export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch {
    throw new AppError('WRITE_ERROR', `目录不可写：${dir}`);
  }
}

/** 磁盘剩余空间（字节），无法获取时返回 null */
export function freeDiskBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    if (typeof s.bavail === 'number' && typeof s.bsize === 'number' && s.bavail > 0) {
      return s.bavail * s.bsize;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 将用户输入的保存目录解析为绝对路径，并确保可写 */
export function resolveFolder(raw: string): string {
  const p = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT_DIR, raw);
  ensureDir(p);
  return p;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function tailOfFile(file: string, bytes = 4096): string {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}
