/**
 * 更新 tools/ytdlp 中的 Python 版 yt-dlp（平台接口变化很快，旧版本常导致 403 / 格式不可用）。
 * 用法：npm run update:ytdlp
 * 会读取 .env 中的 PROXY_URL，并在更新后打印版本号。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env 可选
}

const proxy = (process.env.PROXY_URL || process.env.HTTPS_PROXY || '').trim();
const python = process.env.PYTHON_PATH || 'python';
const target = path.join(ROOT, 'tools', 'ytdlp');
fs.mkdirSync(target, { recursive: true });

const args = [
  '-m',
  'pip',
  'install',
  '--upgrade',
  '--target',
  target,
  '--no-cache-dir',
  'yt-dlp',
];
if (proxy) args.push('--proxy', proxy);

console.log(`[update-ytdlp] ${python} ${args.join(' ')}`);
const install = spawnSync(python, args, { stdio: 'inherit', windowsHide: true });
if (install.status !== 0) {
  console.error('[update-ytdlp] 更新失败，请检查网络/代理设置');
  process.exit(install.status || 1);
}

const version = spawnSync(python, ['-m', 'yt_dlp', '--version'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, PYTHONPATH: target },
});
if (version.status !== 0) {
  console.error('[update-ytdlp] 已安装，但无法运行 yt_dlp，请检查 Python 环境');
  process.exit(1);
}
console.log('[update-ytdlp] 完成。请重启服务后重试下载。');
