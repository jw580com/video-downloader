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

export function detectPlatform(u: URL): Platform {
  let host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    return 'youtube';
  }
  if (host === 'bilibili.com' || host === 'b23.tv') return 'bilibili';
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return 'vimeo';
  if (host === 'x.com' || host === 'twitter.com' || host === 't.co') return 'x';
  if (host === 'tiktok.com' || host === 'vm.tiktok.com') return 'tiktok';
  if (host === 'douyin.com' || host === 'v.douyin.com' || host === 'iesdouyin.com') {
    return 'douyin';
  }
  if (host === 'instagram.com' || host === 'instagr.am') return 'instagram';
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
