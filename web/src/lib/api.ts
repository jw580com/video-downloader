import { ApiError, type AllStats, type Parser, type ParserInput, type PlatformOption, type Settings, type SystemInfo, type Task, type VideoInfo } from './types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', '无法连接服务器，请确认服务已启动');
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(body.error?.code ?? 'INTERNAL', body.error?.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

export interface CreateTaskInput {
  url: string;
  quality: string;
  format: string;
  folder?: string;
  title?: string;
  thumbnail?: string;
  author?: string;
  durationSec?: number;
  formatId?: string;
  totalBytes?: number;
  engine?: 'http' | 'ytdlp';
  platform?: string;
  platformName?: string;
  resolvedUrl?: string;
  headers?: Record<string, string>;
  ytdlpArgs?: string;
  cookiesFile?: string;
}

export interface TaskListResult {
  items: Task[];
  total: number;
}

export interface TaskListParams {
  status?: string;
  platform?: string;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const api = {
  parse(url: string): Promise<{ info: VideoInfo }> {
    return request('/parse', { method: 'POST', body: JSON.stringify({ url }) });
  },
  createTask(input: CreateTaskInput): Promise<{ task: Task }> {
    return request('/tasks', { method: 'POST', body: JSON.stringify(input) });
  },
  listTasks(params: TaskListParams = {}): Promise<TaskListResult> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.platform) q.set('platform', params.platform);
    if (params.search) q.set('search', params.search);
    if (params.sort) q.set('sort', params.sort);
    if (params.order) q.set('order', params.order);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    const qs = q.toString();
    return request(`/tasks${qs ? `?${qs}` : ''}`);
  },
  taskAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<{ task: Task }> {
    return request(`/tasks/${id}/${action}`, { method: 'POST' });
  },
  deleteTask(id: string, withFile: boolean): Promise<{ ok: boolean; fileDeleted: boolean }> {
    return request(`/tasks/${id}${withFile ? '?file=1' : ''}`, { method: 'DELETE' });
  },
  batchDelete(
    ids: string[],
    withFiles: boolean,
  ): Promise<{ ok: boolean; deleted: number; filesDeleted: number; failed: number }> {
    return request('/tasks/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids, withFiles }),
    });
  },
  deleteAll(opts: {
    withFiles: boolean;
    status?: string;
    platform?: string;
    search?: string;
  }): Promise<{ ok: boolean; deleted: number; filesDeleted: number; failed: number }> {
    return request('/tasks/delete-all', { method: 'POST', body: JSON.stringify(opts) });
  },
  deleteFile(id: string): Promise<{ ok: boolean }> {
    return request(`/tasks/${id}/delete-file`, { method: 'POST' });
  },
  openFolder(id: string): Promise<{ ok: boolean; message: string }> {
    return request(`/tasks/${id}/open-folder`, { method: 'POST' });
  },
  getSettings(): Promise<{ settings: Settings }> {
    return request('/settings');
  },
  updateSettings(partial: Partial<Settings>): Promise<{ settings: Settings }> {
    return request('/settings', { method: 'PUT', body: JSON.stringify(partial) });
  },
  getStats(): Promise<AllStats> {
    return request('/stats');
  },
  getPlatforms(): Promise<{ platforms: PlatformOption[] }> {
    return request('/platforms');
  },
  getSystem(): Promise<SystemInfo> {
    return request('/system');
  },
  listParsers(): Promise<{ parsers: Parser[] }> {
    return request('/parsers');
  },
  createParser(input: ParserInput): Promise<{ parser: Parser }> {
    return request('/parsers', { method: 'POST', body: JSON.stringify(input) });
  },
  updateParser(id: string, input: ParserInput): Promise<{ parser: Parser }> {
    return request(`/parsers/${id}`, { method: 'PUT', body: JSON.stringify(input) });
  },
  deleteParser(id: string): Promise<{ ok: boolean }> {
    return request(`/parsers/${id}`, { method: 'DELETE' });
  },
};
