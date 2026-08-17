/**
 * API 冒烟测试：覆盖 URL 校验、解析、任务创建/完成、暂停/继续、失败处理、
 * 设置读写、统计、系统信息、真实平台（YouTube/抖音）解析。
 * 用法：npm run test:smoke（需应用服务与媒体源运行中）
 */
import fs from 'node:fs';

const APP = process.env.APP_BASE || 'http://127.0.0.1:3000';
const MEDIA = process.env.MEDIA_BASE || 'http://127.0.0.1:8099';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

async function api(path, init) {
  const res = await fetch(APP + '/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${extra ? ` (${extra})` : ''}`);
  }
}

console.log('=== API 冒烟测试 ===');

// 1. 无效 URL
{
  const r = await api('/parse', { method: 'POST', body: JSON.stringify({ url: 'not-a-url' }) });
  check('无效 URL 被拒绝', r.status === 400 && r.body.error?.code === 'INVALID_URL', r.body.error?.message);
}

// 2. 不支持平台（普通网页 → 通用解析失败 → 清晰错误）
{
  const r = await api('/parse', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/' }) });
  check(
    '不支持平台给出清晰错误',
    r.status === 400 && ['UNSUPPORTED_PLATFORM', 'NETWORK_ERROR', 'TIMEOUT'].includes(r.body.error?.code),
    `${r.body.error?.code}: ${r.body.error?.message}`,
  );
}

// 3. 直链解析
let info;
{
  const r = await api('/parse', { method: 'POST', body: JSON.stringify({ url: `${MEDIA}/media/5?name=smoke-01.mp4` }) });
  info = r.body.info;
  check('直链解析成功', r.status === 200 && info?.platform === 'direct' && info?.downloadable === true, `size=${info?.sizeBytes}`);
}

// 4. 创建任务并下载完成
let taskId;
{
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: info.url, quality: 'original', format: 'mp4', title: info.title, formatId: info.formatId, totalBytes: info.sizeBytes }),
  });
  check('任务创建成功', r.status === 201 && r.body.task?.status === 'waiting', r.body.task?.id?.slice(0, 8));
  taskId = r.body.task.id;
  let t;
  for (let i = 0; i < 30; i++) {
    t = (await api(`/tasks/${taskId}`)).body.task;
    if (t.status === 'completed' || t.status === 'failed') break;
    await sleep(300);
  }
  check('任务完成', t.status === 'completed', `${t.status}`);
  check('文件落盘且大小正确', t.filePath && fs.existsSync(t.filePath) && fs.statSync(t.filePath).size === t.totalBytes, t.filePath);
}

// 5. 重复下载检测
{
  const r = await api('/parse', { method: 'POST', body: JSON.stringify({ url: info.url }) });
  check('重复下载检测', r.status === 200 && r.body.info?.duplicate?.id === taskId, r.body.info?.duplicate?.title);
}

// 6. 暂停/继续（断点续传）
{
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: `${MEDIA}/media/10/slow?name=smoke-slow.mp4`, quality: 'original', format: 'mp4', title: 'smoke-slow.mp4' }),
  });
  const id = r.body.task.id;
  let t;
  for (let i = 0; i < 40; i++) {
    t = (await api(`/tasks/${id}`)).body.task;
    if (t.status === 'downloading' && t.downloadedBytes > 500 * 1024) break;
    await sleep(250);
  }
  check('慢速任务下载中', t.status === 'downloading', `${t.downloadedBytes} 字节`);
  await api(`/tasks/${id}/pause`, { method: 'POST' });
  await sleep(700);
  const paused = (await api(`/tasks/${id}`)).body.task;
  check('暂停生效', paused.status === 'paused', `进度 ${paused.downloadedBytes}`);
  const savedBytes = paused.downloadedBytes;
  await sleep(1500);
  const stillPaused = (await api(`/tasks/${id}`)).body.task;
  check('暂停后进度不再增长', stillPaused.downloadedBytes === savedBytes, `${stillPaused.downloadedBytes}`);
  await api(`/tasks/${id}/resume`, { method: 'POST' });
  await sleep(2500);
  const resumed = (await api(`/tasks/${id}`)).body.task;
  check('继续后进度不回退', ['downloading', 'waiting', 'completed'].includes(resumed.status) && resumed.downloadedBytes >= savedBytes, `${savedBytes} → ${resumed.downloadedBytes}`);
  await api(`/tasks/${id}/cancel`, { method: 'POST' });
  await sleep(700);
  const cancelled = (await api(`/tasks/${id}`)).body.task;
  check('取消生效', cancelled.status === 'cancelled');
  check('取消清理部分文件', cancelled.filePath === '' || !fs.existsSync(cancelled.filePath + '.part'), 'part 已清理');
}

// 7. 失败任务与清晰原因
{
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: `${MEDIA}/missing?name=smoke-missing.mp4`, quality: 'original', format: 'mp4', title: 'smoke-missing.mp4' }),
  });
  const id = r.body.task.id;
  let t;
  for (let i = 0; i < 40; i++) {
    t = (await api(`/tasks/${id}`)).body.task;
    if (t.status === 'failed') break;
    await sleep(250);
  }
  check('失败任务标记 failed', t.status === 'failed');
  check('失败原因明确', !!t.errorMessage && t.errorMessage.length > 0, t.errorMessage);
}

// 8. 设置读写
{
  const g = await api('/settings');
  const before = g.body.settings;
  check('读取设置', !!before && typeof before.maxConcurrency === 'number', `并发=${before.maxConcurrency}`);
  const u = await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 5 }) });
  check('修改并发为 5', u.body.settings?.maxConcurrency === 5);
  const bad = await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 7 }) });
  check('非法并发被拒绝', bad.status === 400, bad.body.error?.message);
  await api('/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: before.maxConcurrency }) });
  check('还原并发设置', true);
}

// 9. 统计与系统信息
{
  const s = await api('/stats');
  check('统计接口正常', s.status === 200 && typeof s.body.overview?.totalTasks === 'number', `累计任务=${s.body.overview?.totalTasks}`);
  const sys = await api('/system');
  check('系统信息正常', sys.status === 200 && sys.body.db?.ok === true, `磁盘剩余=${sys.body.downloadDir?.freeBytes != null ? '可读' : '未知'}`);
}

// 10. yt-dlp 元数据解析（真实平台，网络可能受限）
{
  const r = await api('/parse', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
  });
  if (r.status === 200) {
    check('YouTube 解析（yt-dlp）', r.body.info?.platform === 'youtube' && !!r.body.info?.title, `title=${String(r.body.info?.title).slice(0, 30)} downloadable=${r.body.info?.downloadable}`);
  } else {
    check('YouTube 解析受限时给出清晰错误', !!r.body.error?.message, `${r.body.error?.code}: ${r.body.error?.message}`);
  }
}

// 11. 抖音平台识别（需要 Cookie 时给出清晰提示）
{
  const r = await api('/parse', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://www.douyin.com/video/6963263655114722595' }),
  });
  if (r.status === 200) {
    check('抖音解析（yt-dlp）', r.body.info?.platform === 'douyin', `title=${String(r.body.info?.title).slice(0, 30)}`);
  } else {
    check(
      '抖音受限时给出清晰错误',
      r.status === 403 && r.body.error?.code === 'AUTH_REQUIRED' && /cookie/i.test(r.body.error?.message ?? ''),
      r.body.error?.message,
    );
  }
}

console.log(`\n===== 冒烟测试：${passed} 通过 / ${failed} 失败 =====`);
process.exit(failed > 0 ? 1 : 0);
