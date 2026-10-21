import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { getSettings } from './db/settings.js';
import { isAppError } from './errors.js';
import { log } from './logger.js';
import { ensureDir } from './util.js';
import { DownloadEngine } from './services/download.js';
import { TaskQueue } from './services/queue.js';
import { recoverOnBoot } from './services/recovery.js';
import { cleanupStaleLogs } from './services/maintenance.js';
import { createApiRouter } from './routes/api.js';

const db = openDatabase();
const settingsRef = { current: getSettings(db) };

ensureDir(settingsRef.current.downloadDir);
ensureDir(path.join(config.dataDir, 'logs'));
cleanupStaleLogs(db);

const queueRef: { queue: TaskQueue | null } = { queue: null };
const engine = new DownloadEngine(
  db,
  () => settingsRef.current,
  () => queueRef.queue!,
);
const queue = new TaskQueue(db, engine, () => settingsRef.current);
queueRef.queue = queue;

recoverOnBoot(db, queue);

const app = express();
app.disable('x-powered-by');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const EXTRA_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 仅允许同源 / 本机开发源访问 API，避免任意网页跨站调用本机服务（CSRF/资源滥用） */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl / 脚本 / 同源无 Origin 的 GET）
  try {
    const o = new URL(origin);
    if (EXTRA_ORIGINS.includes(origin)) return true;
    if (o.host === req.headers.host) return true;
    return LOCAL_HOSTS.has(o.hostname);
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  const allowed = originAllowed(req);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    if (!allowed) {
      res.sendStatus(403);
      return;
    }
    res.sendStatus(204);
    return;
  }
  if (!allowed && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '跨站请求被拒绝' } });
    return;
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(
  '/api',
  createApiRouter({
    db,
    queue,
    getSettingsFn: () => settingsRef.current,
    refreshSettings: () => {
      settingsRef.current = getSettings(db);
    },
  }),
);

// 生产模式：托管前端构建产物
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      name: '在线视频下载管理器',
      version: config.version,
      hint: '前端尚未构建，请运行 npm run build 或使用开发模式',
      api: '/api',
    });
  });
}

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (isAppError(err)) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // 请求体 JSON 解析失败等客户端错误
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in (err as object))) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: '请求体不是合法的 JSON' } });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'BAD_REQUEST', message: '请求体过大' } });
    return;
  }
  log.error('未处理异常：', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务内部错误' } });
});

const pidFile = path.join(config.dataDir, 'server.pid');
const server = app.listen(config.port, config.host, () => {
  log.info(`服务已启动：http://${config.host}:${config.port}`);
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    // ignore
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`收到 ${signal}，正在关闭…`);
  // 先停止接收新连接，再中止并等待下载任务退出，最后关闭数据库
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  const force = setTimeout(() => {
    log.warn('关闭超时，强制退出');
    process.exit(1);
  }, 8000);
  force.unref();
  void (async () => {
    try {
      await queue.shutdown(5000);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await serverClosed;
    } catch (e) {
      log.error('关闭过程中出错：', e);
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // ignore
    }
    clearTimeout(force);
    log.info('服务已关闭');
    process.exit(0);
  })();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log.error('未捕获异常（服务继续运行）：', e);
});
process.on('unhandledRejection', (e) => {
  log.error('未处理的 Promise 拒绝（服务继续运行）：', e);
});
