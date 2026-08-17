import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { getSettings } from './db/settings.js';
import { AppError, isAppError } from './errors.js';
import { log } from './logger.js';
import { ensureDir } from './util.js';
import { DownloadEngine } from './services/download.js';
import { TaskQueue } from './services/queue.js';
import { recoverOnBoot } from './services/recovery.js';
import { createApiRouter } from './routes/api.js';

const db = openDatabase();
const settingsRef = { current: getSettings(db) };

ensureDir(settingsRef.current.downloadDir);
ensureDir(path.join(config.dataDir, 'logs'));

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
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

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
  queue.shutdown();
  server.close(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    log.info('服务已关闭');
    process.exit(0);
  });
  setTimeout(() => {
    log.warn('关闭超时，强制退出');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  log.error('未捕获异常（服务继续运行）：', e);
});
process.on('unhandledRejection', (e) => {
  log.error('未处理的 Promise 拒绝（服务继续运行）：', e);
});
