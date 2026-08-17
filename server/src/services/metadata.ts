import http from 'node:http';
import https from 'node:https';
import type { DB } from '../db/database.js';
import { findCompletedByUrl } from '../db/tasks.js';
import { findParserForHost, type ParserRow } from '../db/parsers.js';
import { AppError, isAppError } from '../errors.js';
import { detectPlatform, extOf, MEDIA_EXTENSIONS, normalizeUrl, PLATFORM_NAMES, type Platform } from './platforms.js';
import { hasFfmpeg, runYtdlpJson, type YtDlpInfo } from './ytdlp.js';
import { runScriptParser } from './parserScript.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface QualityOption {
  value: string;
  label: string;
}

export interface FormatOption {
  value: string;
  label: string;
  sizeBytes?: number;
}

export interface DuplicateInfo {
  id: string;
  title: string;
  completedAt: number;
}

export interface VideoInfo {
  url: string;
  platform: string;
  platformName: string;
  engine: 'http' | 'ytdlp';
  title: string;
  thumbnail: string;
  author: string;
  durationSec: number;
  formatId: string;
  qualities: QualityOption[];
  formats: FormatOption[];
  sizeBytes?: number;
  downloadable: boolean;
  warning?: string;
  duplicate?: DuplicateInfo;
  /** 实际下载地址（脚本型自定义解析源输出） */
  downloadUrl?: string;
  /** 下载请求附加头 */
  headers?: Record<string, string>;
  /** 附加 yt-dlp 参数（自定义解析源快照） */
  ytdlpArgs?: string;
  /** 自定义解析源专用 Cookie 文件 */
  cookiesFile?: string;
}

const DEFAULT_QUALITIES: QualityOption[] = [
  { value: 'best', label: '最佳画质' },
  { value: '1080', label: '1080P' },
  { value: '720', label: '720P' },
  { value: '480', label: '480P' },
  { value: '360', label: '360P' },
];

const DEFAULT_FORMATS: FormatOption[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'm4a', label: 'M4A (音频)' },
];

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** 无 yt-dlp 时的公开元数据回退（oEmbed / 页面标题），仅用于信息展示 */
async function oEmbedFallback(u: URL, platform: Platform): Promise<VideoInfo> {
  const base: VideoInfo = {
    url: u.href,
    platform,
    platformName: PLATFORM_NAMES[platform],
    engine: 'ytdlp',
    title: `${PLATFORM_NAMES[platform]} 视频`,
    thumbnail: '',
    author: '',
    durationSec: 0,
    formatId: '',
    qualities: DEFAULT_QUALITIES,
    formats: DEFAULT_FORMATS,
    downloadable: false,
  };
  try {
    if (platform === 'youtube' || platform === 'vimeo' || platform === 'tiktok') {
      const endpoint =
        platform === 'youtube'
          ? 'https://www.youtube.com/oembed?format=json&url='
          : platform === 'vimeo'
            ? 'https://vimeo.com/api/oembed.json?url='
            : 'https://www.tiktok.com/oembed?url=';
      const data = (await fetchJson(endpoint + encodeURIComponent(u.href))) as {
        title?: unknown;
        author_name?: unknown;
        thumbnail_url?: unknown;
        duration?: unknown;
      };
      if (typeof data.title === 'string' && data.title) base.title = data.title;
      if (typeof data.author_name === 'string' && data.author_name) base.author = data.author_name;
      if (typeof data.thumbnail_url === 'string' && data.thumbnail_url) {
        base.thumbnail = data.thumbnail_url;
      }
      if (typeof data.duration === 'number') base.durationSec = Math.round(data.duration);
    } else if (platform === 'bilibili') {
      const html = await fetchText(u.href);
      const t = html.match(/<title>([^<]*)<\/title>/i);
      if (t?.[1]) base.title = decodeHtml(t[1].trim()).replace(/_哔哩哔哩.*$/, '');
      const img =
        html.match(/property="og:image" content="([^"]+)"/i) ??
        html.match(/name="twitter:image" content="([^"]+)"/i);
      if (img?.[1]) base.thumbnail = img[1];
      const dur = html.match(/"duration"\s*:\s*(\d+)/);
      if (dur?.[1]) base.durationSec = Number(dur[1]);
    } else if (platform === 'douyin') {
      // 抖音分享页在无 Cookie 时通常不提供 SSR 元数据，仅在可用时提取
      const html = await fetchText(u.href);
      const t = html.match(/<title>([^<]*)<\/title>/i);
      if (t?.[1] && t[1].trim()) {
        const cleaned = decodeHtml(t[1].trim()).replace(/[-_]\s*抖音.*$/i, '').trim();
        if (cleaned) base.title = cleaned;
      }
      const img =
        html.match(/property="og:image" content="([^"]+)"/i) ??
        html.match(/name="twitter:image" content="([^"]+)"/i);
      if (img?.[1]) base.thumbnail = img[1];
    }
  } catch {
    // 元数据获取失败时保留基础信息
  }
  return base;
}

function fromYtdlp(u: URL, info: YtDlpInfo, platform: Platform): VideoInfo {
  const fmts = info.formats ?? [];
  const videoFmts = fmts.filter((f) => (f.vcodec ?? 'none') !== 'none' && typeof f.height === 'number');
  const audioFmts = fmts.filter((f) => (f.acodec ?? 'none') !== 'none');
  if (fmts.length > 0 && videoFmts.length === 0 && audioFmts.length === 0) {
    throw new AppError('VIDEO_UNAVAILABLE', '该视频没有可下载的媒体流');
  }
  const heights = [...new Set(videoFmts.map((f) => f.height).filter((h): h is number => h != null && h >= 240))]
    .sort((a, b) => b - a)
    .slice(0, 8);
  const qualities: QualityOption[] = [{ value: 'best', label: '最佳画质' }, ...heights.map((h) => ({ value: String(h), label: `${h}P` }))];
  const videoExts = new Set(videoFmts.map((f) => (f.ext ?? '').toLowerCase()).filter(Boolean));
  const audioExts = new Set(audioFmts.map((f) => (f.ext ?? '').toLowerCase()).filter(Boolean));
  const ffmpeg = hasFfmpeg();
  const formats: FormatOption[] = [];
  const wanted = ['mp4', 'webm', 'mkv'];
  for (const e of wanted) {
    if (videoExts.has(e) || (ffmpeg && videoExts.size > 0)) formats.push({ value: e, label: e.toUpperCase() });
  }
  if (audioExts.has('m4a')) formats.push({ value: 'm4a', label: 'M4A (音频)' });
  if (ffmpeg) formats.push({ value: 'mp3', label: 'MP3 (音频)' });
  if (formats.length === 0) {
    formats.push({ value: 'mp4', label: 'MP4' });
  }
  // 估算文件大小：优先 mp4、最高画质、有 filesize 的格式
  const sizeFmt = [...fmts]
    .filter((f) => f.filesize || f.filesize_approx)
    .sort((a, b) => {
      const sa = a.filesize ?? a.filesize_approx ?? 0;
      const sb = b.filesize ?? b.filesize_approx ?? 0;
      return sb - sa;
    })[0];
  const sizeBytes = sizeFmt ? (sizeFmt.filesize ?? sizeFmt.filesize_approx ?? undefined) : undefined;

  return {
    url: u.href,
    platform,
    platformName: PLATFORM_NAMES[platform],
    engine: 'ytdlp',
    title: (info.title ?? '').trim() || `${PLATFORM_NAMES[platform]} 视频`,
    thumbnail: info.thumbnail ?? '',
    author: (info.uploader ?? info.channel ?? '').trim(),
    durationSec: Math.max(0, Math.round(info.duration ?? 0)),
    formatId: info.id ?? '',
    qualities,
    formats,
    sizeBytes,
    downloadable: true,
  };
}

interface ProbeResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
}

/** 直接探测 URL（HEAD，必要时降级为 Range GET），跟随重定向 */
function probeUrl(rawUrl: string, timeoutMs = 12000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    let url = rawUrl;
    let redirects = 0;
    const attempt = (method: 'HEAD' | 'GET') => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        u,
        {
          method,
          headers: {
            'user-agent': USER_AGENT,
            ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const code = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            res.resume();
            if (++redirects > 5) {
              reject(new AppError('NETWORK_ERROR', '重定向次数过多'));
              return;
            }
            url = new URL(res.headers.location, url).href;
            attempt('HEAD');
            return;
          }
          res.destroy();
          resolve({ statusCode: code, headers: res.headers });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('probe-timeout'));
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        const msg = e.message ?? '';
        if (msg.includes('probe-timeout')) reject(new AppError('TIMEOUT'));
        else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
          reject(new AppError('NETWORK_ERROR', `无法连接目标服务器（${e.code}）`));
        } else reject(new AppError('NETWORK_ERROR'));
      });
      req.end();
    };
    attempt('HEAD');
  });
}

function guessExtFromContentType(ct: string): string {
  const m = ct.toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('x-matroska')) return 'mkv';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('m4a') || m.includes('mp4a')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  return '';
}

async function probeDirect(u: URL): Promise<VideoInfo> {
  let probe: ProbeResult;
  try {
    probe = await probeUrl(u.href);
  } catch (e) {
    if (e instanceof AppError && e.code === 'TIMEOUT' && extOf(u) !== '') {
      // HEAD 超时但路径像媒体文件：仍允许加入队列，下载时再验证
      const ext = extOf(u);
      return directInfo(u, ext);
    }
    throw e;
  }
  const ct = String(probe.headers['content-type'] ?? '').toLowerCase();
  const ext = extOf(u) || guessExtFromContentType(ct);
  const isMediaType = ct.startsWith('video/') || ct.startsWith('audio/') || MEDIA_EXTENSIONS.includes(ext);
  if (!isMediaType) {
    if (probe.statusCode === 404) throw new AppError('VIDEO_NOT_FOUND');
    if (probe.statusCode >= 200 && probe.statusCode < 400) {
      // 普通网页而非媒体文件 → 交给 yt-dlp 通用解析
      throw new AppError('NOT_MEDIA');
    }
    throw new AppError('VIDEO_UNAVAILABLE', `视频资源不可访问（HTTP ${probe.statusCode}）`);
  }
  const length = Number(probe.headers['content-length'] ?? 0) || undefined;
  return directInfo(u, ext, length);
}

function directInfo(u: URL, ext: string, sizeBytes?: number): VideoInfo {
  let name = u.searchParams.get('name') || '';
  if (!name) {
    try {
      name = decodeURIComponent(u.pathname.split('/').pop() ?? '') || 'video';
    } catch {
      name = 'video';
    }
  } else {
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep raw
    }
  }
  const base = name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
  return {
    url: u.href,
    platform: 'direct',
    platformName: PLATFORM_NAMES.direct,
    engine: 'http',
    title: base,
    thumbnail: '',
    author: '',
    durationSec: 0,
    formatId: '',
    qualities: [{ value: 'original', label: '原始画质' }],
    formats: [{ value: ext || 'bin', label: (ext || 'bin').toUpperCase() }],
    sizeBytes,
    downloadable: true,
  };
}

/** 使用用户自定义解析源解析（脚本型：执行脚本拿直链；yt-dlp 型：附加参数调用 yt-dlp） */
async function parseWithCustomParser(
  u: URL,
  parser: ParserRow,
  duplicate?: DuplicateInfo,
): Promise<VideoInfo> {
  if (parser.type === 'script') {
    const out = await runScriptParser(parser.script, u.href, 30000, `解析源「${parser.name}」`);
    const headers: Record<string, string> = {};
    try {
      const configured = JSON.parse(parser.headers || '{}');
      if (configured && typeof configured === 'object') Object.assign(headers, configured);
    } catch {
      // ignore
    }
    Object.assign(headers, out.headers ?? {});
    let ext = 'mp4';
    try {
      ext = extOf(new URL(out.url)) || 'mp4';
    } catch {
      // ignore
    }
    return {
      url: u.href,
      platform: parser.id,
      platformName: parser.name,
      engine: 'http',
      title: out.title || `${parser.name} 视频`,
      thumbnail: out.thumbnail ?? '',
      author: out.author ?? '',
      durationSec: out.durationSec ?? 0,
      formatId: '',
      qualities: [{ value: 'original', label: '原始画质' }],
      formats: [{ value: ext, label: ext.toUpperCase() }],
      sizeBytes: out.sizeBytes,
      downloadable: true,
      downloadUrl: out.url,
      headers,
      duplicate,
    };
  }
  const info = await runYtdlpJson(u.href, 30000, parser.cookiesFile, parser.ytdlpArgs, parser.headers);
  const mapped = fromYtdlp(u, info, 'direct');
  return {
    ...mapped,
    platform: parser.id,
    platformName: parser.name,
    ytdlpArgs: parser.ytdlpArgs,
    cookiesFile: parser.cookiesFile,
    duplicate,
  };
}

export async function parseVideo(db: DB, rawUrl: unknown, cookiesFile = ''): Promise<VideoInfo> {
  const u = normalizeUrl(rawUrl);
  const platform = detectPlatform(u);
  const done = findCompletedByUrl(db, u.href);
  const duplicate: DuplicateInfo | undefined = done
    ? { id: done.id, title: done.title, completedAt: done.completedAt ?? done.createdAt }
    : undefined;

  if (platform === 'direct') {
    // 1) 自定义解析源（域名匹配，内置平台优先于自定义）
    const parser = findParserForHost(db, u.hostname);
    if (parser) return parseWithCustomParser(u, parser, duplicate);
    // 2) 快速探测直链媒体（HEAD / Range GET，命中视频/音频则走直链引擎）
    try {
      const info = await probeDirect(u);
      return { ...info, duplicate };
    } catch (e) {
      if (!isAppError(e) || e.code !== 'NOT_MEDIA') throw e;
      // 3) 普通网页 → 交给 yt-dlp 通用解析（覆盖 1900+ 站点）
      try {
        const info = await runYtdlpJson(u.href, 30000, cookiesFile);
        const mapped = fromYtdlp(u, info, 'generic');
        return { ...mapped, platformName: info.extractor ?? '通用平台', duplicate };
      } catch (e2) {
        if (isAppError(e2) && e2.code === 'INVALID_URL') {
          throw new AppError('UNSUPPORTED_PLATFORM', '当前平台不支持，无法识别该链接');
        }
        throw e2;
      }
    }
  }

  try {
    const info = await runYtdlpJson(u.href, 30000, cookiesFile);
    return { ...fromYtdlp(u, info, platform), duplicate };
  } catch (e) {
    if (isAppError(e) && e.code === 'YTDLP_MISSING') {
      const fallback = await oEmbedFallback(u, platform);
      return {
        ...fallback,
        duplicate,
        downloadable: false,
        warning: '服务器未安装 yt-dlp，暂时无法下载该平台的视频。以下为公开渠道获取到的元数据，安装 yt-dlp 后即可正常下载。',
      };
    }
    throw e;
  }
}
