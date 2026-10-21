import { AppError } from '../errors.js';

export type Platform =
  | 'youtube'
  | 'bilibili'
  | 'vimeo'
  | 'x'
  | 'tiktok'
  | 'douyin'
  | 'instagram'
  | 'generic'
  | 'direct';

export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  vimeo: 'Vimeo',
  x: 'X (Twitter)',
  tiktok: 'TikTok',
  douyin: '抖音 (Douyin)',
  instagram: 'Instagram',
  generic: '通用平台',
  direct: '直链视频',
};

export const MEDIA_EXTENSIONS = [
  'mp4',
  'webm',
  'mkv',
  'mov',
  'm4v',
  'avi',
  'flv',
  'ts',
  'mp3',
  'm4a',
  'aac',
  'wav',
  'ogg',
  'flac',
];

export function normalizeUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw new AppError('INVALID_URL');
  const s = raw.trim();
  if (s.length === 0 || s.length > 4096) throw new AppError('INVALID_URL');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AppError('INVALID_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError('INVALID_URL');
  return u;
}

/** 域名匹配：等于域名本身或为其子域名（避免误匹配 notyoutube.com 之类的域名） */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectPlatform(u: URL): Platform {
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtu.be') || hostMatches(host, 'youtube-nocookie.com')) {
    return 'youtube';
  }
  if (hostMatches(host, 'bilibili.com') || hostMatches(host, 'b23.tv')) return 'bilibili';
  if (hostMatches(host, 'vimeo.com')) return 'vimeo';
  if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com') || hostMatches(host, 't.co')) return 'x';
  if (hostMatches(host, 'tiktok.com')) return 'tiktok';
  if (hostMatches(host, 'douyin.com') || hostMatches(host, 'iesdouyin.com')) return 'douyin';
  if (hostMatches(host, 'instagram.com') || hostMatches(host, 'instagr.am')) return 'instagram';
  return 'direct';
}

export function extOf(u: URL): string {
  try {
    const base = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    const i = base.lastIndexOf('.');
    if (i >= 0) return base.slice(i + 1).toLowerCase();
  } catch {
    // ignore
  }
  return '';
}
