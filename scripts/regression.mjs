/**
 * 回归测试：覆盖本次修复的缺陷与关键边界条件。
 * 依赖：应用服务（默认 http://127.0.0.1:3000）与本地媒体源（默认 http://127.0.0.1:8099）已启动。
 * 用法：npm run test:regression
 *
 * 覆盖点：
 * 0. 任务列表分页、搜索与按搜索条件批量删除
 * 1. 服务器拒绝 HEAD 时，解析自动降级为 GET
 * 2. 暂停“等待中”的任务真正生效
 * 3. 响应尚未返回时暂停立即生效，且之后仍可续传
 * 4. 删除已暂停任务时清理 .part 临时文件
 * 5. format / quality 参数白名单（阻止路径穿越与非法选择器）
 * 6. 截断响应绝不被标记为完成，删除任务时清理残留 .part
 * 7. 崩溃后 .part 大于数据库进度时，续传按文件实际大小进行且字节完全正确
 * 8. HTTP 403 映射为 AUTH_REQUIRED 且不再无意义地自动重试
 * 9. 跨站 Origin 的写请求被拒绝，本机开发源允许 CORS
 * 10. 保存目录不可写时设置更新被拒绝
 * 11. 删除任务时同时删除正片文件
 * 12. 删除任务时同时清理对应日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP = process.env.APP_BASE || 'http://127.0.0.1:3000';
const MEDIA = process.env.MEDIA_BASE || 'http://127.0.0.1:8099';
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve('data/app.db');
const DOWNLOAD_DIR = path.resolve('downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? ` (${extra})` : ''}`);
  if (cond) passed++;
  else failed++;
};

async function api(pathname, init) {
  const res = await fetch(APP + '/api' + pathname, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createTask(title, url, extra = {}) {
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url, quality: 'original', format: 'mp4', title, ...extra }),
  });
  if (r.status !== 201) throw new Error(`创建任务失败：${r.status} ${JSON.stringify(r.body)}`);
  return r.body.task;
}

async function waitFor(id, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  for (;;) {
    task = (await api(`/tasks/${id}`)).body.task;
    if (!task || predicate(task) || Date.now() > deadline) return task;
    await sleep(250);
  }
}

function findPart(task) {
  try {
    const tag = `[${task.id.slice(0, 6)}]`;
    const hit = fs.readdirSync(task.folder).find((f) => f.includes(tag) && f.endsWith('.part'));
    return hit ? path.join(task.folder, hit) : '';
  } catch {
    return '';
  }
}

function byteAt(file, pos) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, pos);
    return b[0];
  } finally {
    fs.closeSync(fd);
  }
}

console.log('=== 回归测试 ===');

const originalSettings = (await api('/settings')).body.settings;
const originalConcurrency = originalSettings.maxConcurrency;
const originalRetries = originalSettings.autoRetries;
const originalProxy = originalSettings.proxyUrl;
await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 3, autoRetries: 2 }) });

// 0. 非法字符串不应让列表接口报错
{
  const r = await api('/tasks?status=__bogus__');
  check('非法 status 过滤被忽略', r.status === 200 && Array.isArray(r.body.items));
}

// 0.1 列表分页与搜索（任务页/历史页分页依赖）
{
  for (let i = 1; i <= 3; i++) {
    await createTask(`reg-page-${i}`, `${MEDIA}/media/1?name=reg-page-${i}.mp4`);
  }
  const p1 = await api('/tasks?search=reg-page&limit=2&offset=0&sort=created_at&order=desc');
  const p2 = await api('/tasks?search=reg-page&limit=2&offset=2&sort=created_at&order=desc');
  check(
    '任务列表分页与搜索正确',
    p1.status === 200 &&
      p1.body.total >= 3 &&
      p1.body.items.length === 2 &&
      p2.body.items.length >= 1 &&
      [...p1.body.items, ...p2.body.items].every((t) => t.title.includes('reg-page')),
    `total=${p1.body.total} page1=${p1.body.items.length} page2=${p2.body.items.length}`,
  );
  const del = await api('/tasks/delete-all', {
    method: 'POST',
    body: JSON.stringify({ withFiles: true, search: 'reg-page' }),
  });
  check('按搜索条件删除全部', del.status === 200 && del.body.deleted >= 3, JSON.stringify(del.body));
}

// 1. HEAD 405 → GET 降级
{
  const r = await api('/parse', {
    method: 'POST',
    body: JSON.stringify({ url: `${MEDIA}/head405` }),
  });
  check(
    'HEAD 被拒绝时降级 GET 解析成功',
    r.status === 200 && r.body.info?.platform === 'direct' && r.body.info?.downloadable === true,
    `${r.status} ${r.body.info?.title ?? r.body.error?.message ?? ''}`,
  );
}

// 2. 暂停等待中的任务
{
  await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 1 }) });
  const slow = await createTask('reg-slow', `${MEDIA}/media/8/slow?name=reg-slow.mp4`);
  const waiting = await createTask('reg-waiting', `${MEDIA}/media/1?name=reg-waiting.mp4`);
  await sleep(600);
  const before = (await api(`/tasks/${waiting.id}`)).body.task;
  const pause = await api(`/tasks/${waiting.id}/pause`, { method: 'POST' });
  const after = (await api(`/tasks/${waiting.id}`)).body.task;
  check(
    '等待中的任务可以暂停',
    before.status === 'waiting' && pause.status === 200 && after.status === 'paused',
    `${before.status} → ${after.status}`,
  );
  await api(`/tasks/${slow.id}/cancel`, { method: 'POST' });
  await api(`/tasks/${waiting.id}/cancel`, { method: 'POST' });
  await sleep(500);
  await api(`/tasks/${slow.id}?file=1`, { method: 'DELETE' });
  await api(`/tasks/${waiting.id}?file=1`, { method: 'DELETE' });
  await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 3 }) });
}

// 3. 响应尚未返回时暂停：应立即生效，且不影响后续继续
{
  const t = await createTask('reg-slowheaders', `${MEDIA}/slowheaders`);
  await sleep(700);
  const before = (await api(`/tasks/${t.id}`)).body.task;
  const pause = await api(`/tasks/${t.id}/pause`, { method: 'POST' });
  await sleep(800);
  const after = (await api(`/tasks/${t.id}`)).body.task;
  check(
    '响应返回前暂停立即生效',
    before.status === 'downloading' && pause.status === 200 && after.status === 'paused',
    `${before.status} → ${after.status}`,
  );
  await api(`/tasks/${t.id}/resume`, { method: 'POST' });
  const done = await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status), 60000);
  check('响应前暂停后仍可正常续传完成', done.status === 'completed', `${done.status} ${done.errorCode}`);
  await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
}

// 4. 删除已暂停任务时清理 .part
{
  const t = await createTask('reg-paused', `${MEDIA}/media/10/slow?name=reg-paused.mp4`);
  let cur = await waitFor(t.id, (x) => x.status === 'downloading' && x.downloadedBytes > 300 * 1024);
  await api(`/tasks/${t.id}/pause`, { method: 'POST' });
  await sleep(800);
  cur = (await api(`/tasks/${t.id}`)).body.task;
  const part = findPart(cur);
  const existed = Boolean(part && fs.existsSync(part));
  const del = await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
  await sleep(500);
  check('删除暂停任务清理 .part', existed && del.status === 200 && !(part && fs.existsSync(part)));
}

// 5. 参数白名单
{
  const badFormat = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      url: `${MEDIA}/media/1?name=reg-format.mp4`,
      quality: 'original',
      format: 'a/../../../reg-evil',
      title: 'reg-format',
    }),
  });
  check('format 路径穿越被拒绝', badFormat.status === 400, badFormat.body.error?.message);
  const badQuality = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      url: `${MEDIA}/media/1?name=reg-quality.mp4`,
      quality: 'best[height<=1]//evil',
      format: 'mp4',
      title: 'reg-quality',
    }),
  });
  check('非法 quality 被拒绝', badQuality.status === 400, badQuality.body.error?.message);
}

// 6. 截断响应 → failed，且删除时清理 .part
{
  const t = await createTask('reg-flaky', `${MEDIA}/flaky`);
  const cur = await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status), 60000);
  check('截断响应不会被标记为完成', cur.status === 'failed', `${cur.status} ${cur.errorCode}`);
  const part = findPart(cur);
  const del = await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
  await sleep(300);
  check('删除失败任务清理残留 .part', del.status === 200 && !(part && fs.existsSync(part)));
}

// 7. 崩溃后 .part 大于数据库进度 → 续传字节正确
{
  const totalBytes = 6 * 1024 * 1024;
  const t = await createTask('reg-resume', `${MEDIA}/media/6/slow?name=reg-resume.mp4`);
  let cur = await waitFor(t.id, (x) => x.status === 'downloading' && x.downloadedBytes > 512 * 1024);
  await api(`/tasks/${t.id}/pause`, { method: 'POST' });
  await sleep(800);
  cur = (await api(`/tasks/${t.id}`)).body.task;
  const part = findPart(cur);
  const partSize = part ? fs.statSync(part).size : 0;
  const fakeProgress = Math.max(0, partSize - 300 * 1024);
  const db = new DatabaseSync(DB_PATH);
  db.prepare('UPDATE tasks SET downloaded_bytes = ? WHERE id = ?').run(fakeProgress, t.id);
  db.close();
  await api(`/tasks/${t.id}/resume`, { method: 'POST' });
  const done = await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status), 120000);
  const file = done.filePath;
  const size = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
  const patternOk =
    size === totalBytes &&
    [0, partSize - 1, partSize, size - 1].every((pos) => byteAt(file, pos) === (pos & 0xff));
  check(
    '崩溃后按 .part 实际大小续传且字节正确',
    done.status === 'completed' && size === totalBytes && patternOk,
    `part=${partSize} db=${fakeProgress} final=${size}`,
  );
  await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
}

// 8. 403 → AUTH_REQUIRED，且不做无意义自动重试
{
  const t = await createTask('reg-403', `${MEDIA}/forbidden`);
  const cur = await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status), 15000);
  check(
    'HTTP 403 映射为 AUTH_REQUIRED 且不自动重试',
    cur.status === 'failed' && cur.errorCode === 'AUTH_REQUIRED' && cur.retryCount === 0,
    `${cur.status} ${cur.errorCode} retry=${cur.retryCount}`,
  );
  await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
}

// 9. CORS / 跨站写请求
{
  const evil = await fetch(APP + '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ url: `${MEDIA}/media/1?name=reg-evil.mp4` }),
  });
  check('跨站写请求被拒绝', evil.status === 403, `HTTP ${evil.status}`);
  const local = await fetch(APP + '/api/health', {
    headers: { origin: 'http://localhost:5173' },
  });
  check(
    '本机开发源允许 CORS',
    local.status === 200 && local.headers.get('access-control-allow-origin') === 'http://localhost:5173',
  );
}

// 10. 不可写保存目录被拒绝
{
  const bad = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ downloadDir: 'Z:/__vdm_missing_dir__' }),
  });
  check('不可写保存目录被拒绝', bad.status === 400, bad.body.error?.message);
  const after = (await api('/settings')).body.settings;
  check('拒绝后原设置未被修改', after.downloadDir === originalSettings.downloadDir);
}

// 10.1 代理地址校验与端口简写
{
  const badProxy = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ proxyUrl: 'ftp://127.0.0.1:10020' }),
  });
  check('非法代理协议被拒绝', badProxy.status === 400, badProxy.body.error?.message);
  const goodProxy = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ proxyUrl: '10020' }),
  });
  check(
    '仅填端口会规范化为本机 HTTP 代理',
    goodProxy.status === 200 && goodProxy.body.settings?.proxyUrl === 'http://127.0.0.1:10020',
    goodProxy.body.settings?.proxyUrl,
  );
}

// 11. 删除任务同时删除正片
{
  const t = await createTask('reg-file', `${MEDIA}/media/1?name=reg-file.mp4`);
  const done = await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status));
  const file = done.filePath;
  const existed = Boolean(file && fs.existsSync(file));
  const del = await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
  check(
    '删除任务同时删除正片',
    existed && del.status === 200 && del.body.fileDeleted === true && !fs.existsSync(file),
  );
  if (existed && file && fs.existsSync(file)) fs.unlinkSync(file);
}

// 12. 删除任务记录时清理对应日志
{
  const t = await createTask('reg-log', `${MEDIA}/media/1?name=reg-log.mp4`);
  await waitFor(t.id, (x) => ['completed', 'failed'].includes(x.status));
  const logDir = path.resolve(process.env.DATA_DIR || 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${t.id}.log`);
  fs.writeFileSync(logPath, 'fake yt-dlp log');
  await api(`/tasks/${t.id}?file=1`, { method: 'DELETE' });
  await sleep(500);
  check('删除任务同时清理日志', !fs.existsSync(logPath));
}

// 清理残留（本次测试创建的文件）
try {
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    if (/^reg-(slow|waiting|paused|flaky|resume|file|page|log)/.test(f)) {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
    }
  }
} catch {
  // ignore
}

await api('/settings', {
  method: 'PUT',
  body: JSON.stringify({
    maxConcurrency: originalConcurrency,
    autoRetries: originalRetries,
    proxyUrl: originalProxy,
  }),
});

console.log(`\n===== 回归测试：${passed} 通过 / ${failed} 失败 =====`);
process.exit(failed > 0 ? 1 : 0);
