import type { TaskStatus } from './types';

export interface PlatformMeta {
  name: string;
  badgeClass: string;
  dotClass: string;
}

export const PLATFORM_META: Record<string, PlatformMeta> = {
  youtube: {
    name: 'YouTube',
    badgeClass: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30',
    dotClass: 'bg-red-500',
  },
  bilibili: {
    name: 'Bilibili',
    badgeClass:
      'bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-500/10 dark:text-pink-400 dark:ring-pink-500/30',
    dotClass: 'bg-pink-500',
  },
  vimeo: {
    name: 'Vimeo',
    badgeClass:
      'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/30',
    dotClass: 'bg-sky-500',
  },
  x: {
    name: 'X (Twitter)',
    badgeClass:
      'bg-zinc-100 text-zinc-800 ring-zinc-300 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-500/30',
    dotClass: 'bg-zinc-800 dark:bg-zinc-400',
  },
  tiktok: {
    name: 'TikTok',
    badgeClass:
      'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-400 dark:ring-cyan-500/30',
    dotClass: 'bg-cyan-500',
  },
  douyin: {
    name: '抖音',
    badgeClass:
      'bg-zinc-900 text-white ring-zinc-700 dark:bg-white/10 dark:text-zinc-100 dark:ring-white/25',
    dotClass: 'bg-cyan-400',
  },
  instagram: {
    name: 'Instagram',
    badgeClass:
      'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-500/10 dark:text-fuchsia-400 dark:ring-fuchsia-500/30',
    dotClass: 'bg-fuchsia-500',
  },
  generic: {
    name: '通用平台',
    badgeClass:
      'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:ring-violet-500/30',
    dotClass: 'bg-violet-500',
  },
  direct: {
    name: '直链视频',
    badgeClass:
      'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:ring-indigo-500/30',
    dotClass: 'bg-indigo-500',
  },
};

export interface StatusMeta {
  label: string;
  badgeClass: string;
  barClass: string;
  dotClass: string;
  animated: boolean;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  waiting: {
    label: '等待中',
    badgeClass: 'bg-slate-100 text-slate-600 ring-slate-300 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-500/30',
    barClass: 'bg-slate-300 dark:bg-slate-600',
    dotClass: 'bg-slate-400',
    animated: false,
  },
  parsing: {
    label: '解析中',
    badgeClass: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/30',
    barClass: 'bg-blue-400',
    dotClass: 'bg-blue-500 animate-pulse',
    animated: true,
  },
  downloading: {
    label: '下载中',
    badgeClass:
      'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:ring-indigo-500/30',
    barClass: 'bg-gradient-to-r from-indigo-500 to-violet-500',
    dotClass: 'bg-indigo-500 animate-pulse',
    animated: true,
  },
  paused: {
    label: '已暂停',
    badgeClass: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/30',
    barClass: 'bg-amber-400',
    dotClass: 'bg-amber-500',
    animated: false,
  },
  completed: {
    label: '已完成',
    badgeClass:
      'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/30',
    barClass: 'bg-emerald-500',
    dotClass: 'bg-emerald-500',
    animated: false,
  },
  failed: {
    label: '失败',
    badgeClass: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/30',
    barClass: 'bg-rose-500',
    dotClass: 'bg-rose-500',
    animated: false,
  },
  cancelled: {
    label: '已取消',
    badgeClass: 'bg-slate-100 text-slate-500 ring-slate-300 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-500/30',
    barClass: 'bg-slate-400',
    dotClass: 'bg-slate-400',
    animated: false,
  },
};

export const QUALITY_OPTIONS = [
  { value: 'best', label: '最佳画质' },
  { value: '2160', label: '2160P (4K)' },
  { value: '1440', label: '1440P (2K)' },
  { value: '1080', label: '1080P' },
  { value: '720', label: '720P' },
  { value: '480', label: '480P' },
  { value: '360', label: '360P' },
];

export const FORMAT_OPTIONS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mkv', label: 'MKV' },
  { value: 'm4a', label: 'M4A (音频)' },
  { value: 'mp3', label: 'MP3 (音频)' },
];

export const CONCURRENCY_OPTIONS = [1, 2, 3, 5, 10];

export const SUPPORTED_PLATFORM_CHIPS = ['YouTube', 'Bilibili', 'Vimeo', 'X', 'TikTok', '抖音', 'Instagram'];
