import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '../..');

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // .env 可选
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return String(pkg.version || '1.0.0');
  } catch {
    return '1.0.0';
  }
}

export const config = {
  port: envInt('PORT', 3000),
  host: envStr('HOST', '0.0.0.0'),
  version: readVersion(),
  dataDir: path.resolve(ROOT_DIR, envStr('DATA_DIR', 'data')),
  dbPath: process.env.DB_PATH
    ? path.resolve(ROOT_DIR, process.env.DB_PATH)
    : path.join(ROOT_DIR, 'data', 'app.db'),
  defaultDownloadDir: path.resolve(ROOT_DIR, envStr('DOWNLOAD_DIR', 'downloads')),
  toolsDir: path.join(ROOT_DIR, 'tools'),
  ytdlpPath: process.env.YTDLP_PATH
    ? path.resolve(ROOT_DIR, process.env.YTDLP_PATH)
    : path.join(ROOT_DIR, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ffmpegPath: process.env.FFMPEG_PATH
    ? path.resolve(ROOT_DIR, process.env.FFMPEG_PATH)
    : path.join(ROOT_DIR, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  pythonPath: envStr('PYTHON_PATH', process.platform === 'win32' ? 'python' : 'python3'),
  ytdlpModuleDir: process.env.YTDLP_MODULE_DIR
    ? path.resolve(ROOT_DIR, process.env.YTDLP_MODULE_DIR)
    : path.join(ROOT_DIR, 'tools', 'ytdlp'),
};
