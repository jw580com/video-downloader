import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, errMessage } from '../errors.js';
import { tailOfFile } from '../util.js';
import { log } from '../logger.js';

export interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  height?: number | null;
  width?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  format_note?: string | null;
}

export interface YtDlpInfo {
  id?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  extractor?: string;
  formats?: YtDlpFormat[];
}

let cachedRunner: YtdlpRunner | null | undefined;
let cachedRunnerAt = 0;
/** 未找到 yt-dlp 时的缓存有效期：允许用户安装后无需重启服务即可生效 */
const MISSING_CACHE_MS = 30_000;

export interface YtdlpRunner {
  cmd: string;
  argsPrefix: string[];
  label: string;
}

/** yt-dlp 子进程的沙箱友好环境：临时目录与缓存指向工作区，避免系统 TEMP 写入受限 */
export function ytdlpEnv(): NodeJS.ProcessEnv {
  const tmp = path.join(config.dataDir, 'tmp');
  try {
    fs.mkdirSync(tmp, { recursive: true });
  } catch {
    // ignore
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMP: tmp,
    TEMP: tmp,
    PYTHONPYCACHEPREFIX: path.join(config.dataDir, 'pycache'),
    PYTHONUTF8: '1',
  };
  if (fs.existsSync(config.ytdlpModuleDir)) {
    env.PYTHONPATH = [config.ytdlpModuleDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/**
 * 定位 yt-dlp 运行器，优先级：
 * 1. tools/ytdlp 模块目录 + 系统 Python（python -m yt_dlp，无 PyInstaller 解压依赖）
 * 2. 系统 Python 的 yt_dlp 模块
 * 3. 配置路径 / tools 目录中的 yt-dlp 可执行文件
 * 4. PATH 中的 yt-dlp
 */
export function findYtdlp(): YtdlpRunner | null {
  if (cachedRunner !== undefined) {
    if (cachedRunner !== null) return cachedRunner;
    // 未安装的情况只缓存一小段时间，安装后无需重启服务
    if (Date.now() - cachedRunnerAt < MISSING_CACHE_MS) return null;
  }
  const pyCandidates: string[] = [];
  if (fs.existsSync(config.ytdlpModuleDir)) {
    pyCandidates.push(config.pythonPath, 'python', 'python3');
  }
  pyCandidates.push(config.pythonPath, 'python', 'python3');
  for (const py of [...new Set(pyCandidates)]) {
    try {
      const env = ytdlpEnv();
      if (fs.existsSync(config.ytdlpModuleDir)) {
        env.PYTHONPATH = [config.ytdlpModuleDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      }
      const r = spawnSync(py, ['-m', 'yt_dlp', '--version'], {
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      if (r.status === 0) {
        log.info(`使用 yt-dlp：${py} -m yt_dlp`);
        cachedRunner = { cmd: py, argsPrefix: ['-m', 'yt_dlp'], label: 'python-module' };
        cachedRunnerAt = Date.now();
        return cachedRunner;
      }
    } catch {
      // ignore
    }
  }
  const candidates: string[] = [config.ytdlpPath];
  candidates.push(
    path.join(config.toolsDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  );
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) continue;
      const r = spawnSync(c, ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
        env: ytdlpEnv(),
      });
      if (r.status === 0) {
        log.info(`使用 yt-dlp：${c}`);
        cachedRunner = { cmd: c, argsPrefix: [], label: 'binary' };
        cachedRunnerAt = Date.now();
        return cachedRunner;
      }
    } catch {
      // ignore
    }
  }
  try {
    const r = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) {
      cachedRunner = { cmd: 'yt-dlp', argsPrefix: [], label: 'path' };
      cachedRunnerAt = Date.now();
      return cachedRunner;
    }
  } catch {
    // ignore
  }
  cachedRunner = null;
  cachedRunnerAt = Date.now();
  return null;
}

let cachedFfmpeg: boolean | undefined;
let cachedFfmpegAt = 0;

/** 检测 ffmpeg 是否可用（存在且能实际运行；用于合并音视频 / mp3 转码） */
export function hasFfmpeg(): boolean {
  if (cachedFfmpeg === true) return true;
  if (cachedFfmpeg === false && Date.now() - cachedFfmpegAt < MISSING_CACHE_MS) return false;
  const candidates: string[] = [];
  try {
    if (fs.existsSync(config.ffmpegPath) && fs.statSync(config.ffmpegPath).isFile()) {
      candidates.push(config.ffmpegPath);
    }
  } catch {
    // ignore
  }
  candidates.push('ffmpeg');
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true });
      if (r.status === 0) {
        cachedFfmpeg = true;
        cachedFfmpegAt = Date.now();
        return true;
      }
    } catch {
      // ignore
    }
  }
  cachedFfmpeg = false;
  cachedFfmpegAt = Date.now();
  return false;
}

/** 将 yt-dlp 的报错日志映射为清晰的错误类型 */
export function mapYtdlpError(tail: string): AppError {
  const t = tail.slice(-2000);
  if (/fresh cookies|cookies? (are|is)?\s*(needed|required)|cookie required/i.test(t)) {
    return new AppError(
      'AUTH_REQUIRED',
      '该视频需要新鲜 Cookie（平台访问控制）。可在「设置 → 网络设置」中配置你的 Cookie 文件后重试',
    );
  }
  if (/is not a valid url|unsupported url/i.test(t)) return new AppError('INVALID_URL');
  if (/private video|sign in|login|members-only|age-restricted/i.test(t)) {
    return new AppError('AUTH_REQUIRED');
  }
  if (/video unavailable|this video is not available|removed|does not exist|not found/i.test(t)) {
    return new AppError('VIDEO_NOT_FOUND');
  }
  if (/timed out|read timed out|etimedout/i.test(t)) return new AppError('TIMEOUT');
  if (/no space left|not enough space|disk full|enospc/i.test(t)) return new AppError('DISK_FULL');
  if (/permission denied|eacces/i.test(t)) return new AppError('WRITE_ERROR');
  if (/http error 429|too many requests|rate.?limit/i.test(t)) {
    return new AppError('VIDEO_UNAVAILABLE', '请求过于频繁（HTTP 429），请稍后重试');
  }
  if (/http error 403|forbidden/i.test(t)) {
    return new AppError('AUTH_REQUIRED', '该视频需要登录或存在访问控制，无法下载（HTTP 403）');
  }
  if (/unable to download|network|connection|getaddrinfo|econn|dns/i.test(t)) {
    return new AppError('NETWORK_ERROR');
  }
  const excerpt = t
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*$/.test(l))
    .slice(-2)
    .join(' ')
    .slice(0, 180);
  return new AppError(
    'VIDEO_UNAVAILABLE',
    `${errMessage('VIDEO_UNAVAILABLE')}${excerpt ? `（${excerpt}）` : ''}`,
  );
}

/**
 * 运行 yt-dlp 提取视频元数据（JSON）。
 * 注意：受运行环境限制，子进程 stdio 使用文件描述符重定向，而不是管道。
 * cookiesFile：可选，用户自备的 Netscape 格式 Cookie 文件（用于需要登录/访问控制的平台视频）。
 * extraArgs：可选，附加 yt-dlp 参数（每行一个）。
 * headersJson：可选，附加请求头（JSON 对象，如 {"Referer":"..."}）。
 */
export async function runYtdlpJson(
  url: string,
  timeoutMs = 30000,
  cookiesFile = '',
  extraArgs = '',
  headersJson = '',
  proxyUrl = '',
): Promise<YtDlpInfo> {
  const runner = findYtdlp();
  if (!runner) throw new AppError('YTDLP_MISSING');
  const token = crypto.randomBytes(6).toString('hex');
  const outFile = path.join(config.dataDir, 'logs', `info-${token}.json`);
  const errFile = `${outFile}.log`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  try {
    const args = [
      ...runner.argsPrefix,
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      String(Math.max(5, Math.floor(timeoutMs / 1000))),
      '--retries',
      '1',
    ];
    if (proxyUrl) args.push('--proxy', proxyUrl);
    if (cookiesFile && fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);
    if (extraArgs) {
      for (const line of extraArgs.split(/\r?\n/)) {
        const a = line.trim();
        if (a) args.push(a);
      }
    }
    if (headersJson) {
      try {
        const h = JSON.parse(headersJson) as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          if (k && v) args.push('--add-headers', `${k}:${v}`);
        }
      } catch {
        // 无效的 headers 配置忽略
      }
    }
    args.push(url);
    const exitCode = await new Promise<number>((resolve, reject) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(runner.cmd, args, {
          stdio: ['ignore', fdOut, fdErr],
          windowsHide: true,
          env: ytdlpEnv(),
        });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new AppError('TIMEOUT', '解析视频信息超时'));
      }, timeoutMs);
      proc.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === 'ENOENT'
            ? new AppError('YTDLP_MISSING')
            : new AppError('NETWORK_ERROR', `无法启动 yt-dlp（${e.code ?? e.message}）`),
        );
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) throw mapYtdlpError(tailOfFile(errFile));
    const text = fs.readFileSync(outFile, 'utf8').trim();
    if (!text) throw new AppError('VIDEO_UNAVAILABLE', '未获取到视频信息');
    return JSON.parse(text) as YtDlpInfo;
  } finally {
    try {
      fs.closeSync(fdOut);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(fdErr);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(errFile);
    } catch {
      // ignore
    }
  }
}

/** 根据质量与格式构建 yt-dlp 格式选择器（优先渐进式单文件，避免依赖 ffmpeg） */
export function buildFormatSelector(quality: string, format: string, ffmpeg: boolean): string {
  const h = quality === 'best' ? '' : `[height<=${quality}]`;
  if (format === 'mp3') return 'bestaudio/best';
  if (format === 'm4a') return 'bestaudio[ext=m4a]/bestaudio';
  if (ffmpeg) {
    return `bestvideo${h}[ext=${format}]+bestaudio/bestvideo${h}+bestaudio/best${h}[ext=${format}]/best${h}`;
  }
  return `best${h}[ext=${format}]/best${h}`;
}
