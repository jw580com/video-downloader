/**
 * 自定义解析源 + 通用平台验证：
 * 1. 解析源 CRUD
 * 2. 脚本型解析源：解析 → 创建任务 → 下载完成 → 文件落盘
 * 3. 通用 yt-dlp 直通（非内置平台，网络可用则成功，否则给出清晰错误）
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP_BASE || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? ` (${extra})` : ''}`);
  cond ? passed++ : failed++;
};
const api = async (p, init) => {
  const res = await fetch(APP + '/api' + p, { headers: { 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log('=== 自定义解析源验证 ===');

// 1. CRUD
const scriptPath = path.resolve('scripts/fixtures/fake-parser.mjs').replace(/\\/g, '\\\\');
const created = await api('/parsers', {
  method: 'POST',
  body: JSON.stringify({
    name: '本地测试源',
    domains: 'test.local',
    type: 'script',
    enabled: true,
    script: `node ${scriptPath} {url}`,
    headers: '{"Referer":"https://test.local"}',
  }),
});
check('创建解析源', created.status === 201 && created.body.parser?.type === 'script', created.body.parser?.id?.slice(0, 8));
const pid = created.body.parser.id;

const bad = await api('/parsers', {
  method: 'POST',
  body: JSON.stringify({ name: 'x', domains: 'x.com', type: 'script', script: '' }),
});
check('脚本型缺脚本被拒绝', bad.status === 400, bad.body.error?.message);

const badHeaders = await api('/parsers', {
  method: 'POST',
  body: JSON.stringify({ name: 'x', domains: 'x.com', type: 'ytdlp', headers: 'not-json' }),
});
check('非法 headers 被拒绝', badHeaders.status === 400, badHeaders.body.error?.message);

const updated = await api(`/parsers/${pid}`, {
  method: 'PUT',
  body: JSON.stringify({ name: '本地测试源(改)', domains: 'test.local', type: 'script', enabled: true, script: `node ${scriptPath} {url}`, headers: '{"Referer":"https://test.local"}' }),
});
check('更新解析源', updated.status === 200 && updated.body.parser?.name.includes('改'));

// 2. 脚本型解析源全流程：解析 → 任务 → 下载完成
const parsed = await api('/parse', { method: 'POST', body: JSON.stringify({ url: 'https://test.local/video/12345' }) });
check(
  '脚本解析成功',
  parsed.status === 200 &&
    parsed.body.info?.platform === pid &&
    parsed.body.info?.platformName?.includes('本地测试源') &&
    parsed.body.info?.engine === 'http' &&
    !!parsed.body.info?.downloadUrl,
  `${parsed.body.info?.platformName} | downloadUrl=${parsed.body.info?.downloadUrl}`,
);
check('脚本解析头信息合并', parsed.body.info?.headers?.Referer === 'https://test.local');

const info = parsed.body.info;
const taskRes = await api('/tasks', {
  method: 'POST',
  body: JSON.stringify({
    url: info.url,
    quality: 'original',
    format: 'mp4',
    title: info.title,
    author: info.author,
    durationSec: info.durationSec,
    totalBytes: info.sizeBytes ?? 0,
    engine: info.engine,
    platform: info.platform,
    platformName: info.platformName,
    resolvedUrl: info.downloadUrl,
    headers: info.headers,
  }),
});
check('任务创建(脚本源)', taskRes.status === 201, taskRes.body.task?.id?.slice(0, 8));
const taskId = taskRes.body.task.id;
let t;
for (let i = 0; i < 40; i++) {
  t = (await api(`/tasks/${taskId}`)).body.task;
  if (t.status === 'completed' || t.status === 'failed') break;
  await sleep(300);
}
check('任务完成(脚本源)', t.status === 'completed', t.errorMessage || '');
check(
  '文件落盘且大小正确',
  t.status === 'completed' && t.filePath && fs.existsSync(t.filePath) && fs.statSync(t.filePath).size === 3 * 1024 * 1024,
  t.filePath,
);
check('平台名快照正确', t.platformName?.includes('本地测试源'), t.platformName);

// 3. 删除解析源
const del = await api(`/parsers/${pid}`, { method: 'DELETE' });
const gone = await api(`/parsers/${pid}`, { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
check('删除解析源', del.status === 200 && gone.status === 404);

// 4. 通用 yt-dlp 直通（非内置平台：Dailymotion，网络可用则成功否则清晰错误）
const generic = await api('/parse', {
  method: 'POST',
  body: JSON.stringify({ url: 'https://www.dailymotion.com/video/x84sh87' }),
});
if (generic.status === 200 && generic.body.info?.downloadable) {
  check('通用平台解析（yt-dlp 直通）', generic.body.info?.platform === 'generic', `extractor=${generic.body.info?.platformName}`);
} else {
  check('通用平台受限时给出清晰错误', !!generic.body.error?.message, `${generic.body.error?.code}: ${generic.body.error?.message}`);
}

console.log(`\n===== 自定义解析源验证：${passed} 通过 / ${failed} 失败 =====`);
process.exit(failed > 0 ? 1 : 0);
