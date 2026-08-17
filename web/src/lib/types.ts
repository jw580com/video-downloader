export type TaskStatus =
  | 'waiting'
  | 'parsing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskEngine = 'http' | 'ytdlp';

export type Platform =
  | 'youtube'
  | 'bilibili'
  | 'vimeo'
  | 'x'
  | 'tiktok'
  | 'instagram'
  | 'direct';

export interface Task {
  id: string;
  url: string;
  platform: string;
  title: string;
  thumbnail: string;
  author: string;
  durationSec: number;
  quality: string;
  format: string;
  formatId: string;
  engine: TaskEngine;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  speedBps: number;
  etaSec: number;
  errorCode: string;
  errorMessage: string;
  filePath: string;
  folder: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  resolvedUrl: string;
  headers: string;
  platformName: string;
  ytdlpArgs: string;
  cookiesFile: string;
}

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
  downloadUrl?: string;
  headers?: Record<string, string>;
  ytdlpArgs?: string;
  cookiesFile?: string;
}

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

export interface StatsOverview {
  todayTasks: number;
  todayCompleted: number;
  downloading: number;
  todayFailed: number;
  totalBytes: number;
  totalTasks: number;
  completedTotal: number;
  failedTotal: number;
  successRate: number;
}

export interface PlatformCount {
  platform: string;
  count: number;
}

export interface DailyStat {
  date: string;
  label: string;
  count: number;
  bytes: number;
}

export interface AllStats {
  overview: StatsOverview;
  platforms: PlatformCount[];
  daily: DailyStat[];
  recent: Task[];
}

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  uptimeSec: number;
  queue: { active: number; waiting: number };
  db: { ok: boolean; path: string; sizeBytes: number; taskCount: number };
  downloadDir: { path: string; exists: boolean; writable: boolean; freeBytes: number | null };
}

export interface Parser {
  id: string;
  name: string;
  domains: string;
  type: 'ytdlp' | 'script';
  enabled: boolean;
  ytdlpArgs: string;
  headers: string;
  script: string;
  cookiesFile: string;
  createdAt: number;
}

export interface ParserInput {
  name: string;
  domains: string;
  type: 'ytdlp' | 'script';
  enabled: boolean;
  ytdlpArgs: string;
  headers: string;
  script: string;
  cookiesFile: string;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
