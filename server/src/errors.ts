export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'VIDEO_NOT_FOUND'
  | 'VIDEO_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'DISK_FULL'
  | 'WRITE_ERROR'
  | 'YTDLP_MISSING'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | 'NOT_MEDIA';

const MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: 'URL 无效，请输入合法的 http(s) 视频链接',
  UNSUPPORTED_PLATFORM: '当前平台不支持',
  VIDEO_NOT_FOUND: '视频不存在或已被删除',
  VIDEO_UNAVAILABLE: '视频资源不可访问',
  AUTH_REQUIRED: '该视频需要登录或存在访问控制，无法下载',
  NETWORK_ERROR: '网络连接中断',
  TIMEOUT: '下载超时',
  DISK_FULL: '磁盘空间不足',
  WRITE_ERROR: '文件写入失败',
  YTDLP_MISSING: '该平台需要 yt-dlp 支持，请先安装 yt-dlp',
  BAD_REQUEST: '请求参数有误',
  NOT_FOUND: '资源不存在',
  INTERNAL: '服务内部错误',
  NOT_MEDIA: '该链接不是可直接下载的媒体文件',
};

export function errMessage(code: ErrorCode): string {
  return MESSAGES[code];
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  VIDEO_NOT_FOUND: 404,
  AUTH_REQUIRED: 403,
  NETWORK_ERROR: 502,
  TIMEOUT: 504,
  DISK_FULL: 507,
  WRITE_ERROR: 500,
  INTERNAL: 500,
  YTDLP_MISSING: 501,
  BAD_REQUEST: 400,
  INVALID_URL: 400,
  UNSUPPORTED_PLATFORM: 400,
  VIDEO_UNAVAILABLE: 422,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
    public status = STATUS_BY_CODE[code] ?? 400,
  ) {
    super(message ?? MESSAGES[code]);
    this.name = 'AppError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
