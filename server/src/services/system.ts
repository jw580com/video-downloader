import fs from 'node:fs';
import type { DB } from '../db/database.js';
import type { Settings } from '../db/settings.js';
import { countByStatus } from '../db/tasks.js';
import { config } from '../config.js';
import { freeDiskBytes } from '../util.js';
import type { TaskQueue } from './queue.js';

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  uptimeSec: number;
  queue: { active: number; waiting: number };
  db: {
    ok: boolean;
    path: string;
    sizeBytes: number;
    taskCount: number;
  };
  downloadDir: {
    path: string;
    exists: boolean;
    writable: boolean;
    freeBytes: number | null;
  };
}

export function getSystemInfo(db: DB, queue: TaskQueue, settings: Settings): SystemInfo {
  let dbOk = false;
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    dbOk = row?.integrity_check === 'ok';
  } catch {
    dbOk = false;
  }
  let dbSize = 0;
  try {
    dbSize = fs.statSync(config.dbPath).size;
  } catch {
    // ignore
  }
  const dir = settings.downloadDir;
  let exists = false;
  let writable = false;
  try {
    const st = fs.statSync(dir);
    exists = st.isDirectory();
    if (exists) {
      const probe = `${dir}/.write-test-${process.pid}-${Date.now()}`;
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writable = true;
    }
  } catch {
    // ignore
  }
  return {
    version: config.version,
    node: process.version,
    platform: process.platform,
    uptimeSec: Math.round(process.uptime()),
    queue: { active: queue.activeCount, waiting: queue.waitingCount },
    db: {
      ok: dbOk,
      path: config.dbPath,
      sizeBytes: dbSize,
      taskCount: Object.values(countByStatus(db)).reduce((a, b) => a + b, 0),
    },
    downloadDir: {
      path: dir,
      exists,
      writable,
      freeBytes: freeDiskBytes(dir),
    },
  };
}
