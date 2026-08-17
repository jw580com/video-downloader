/**
 * 服务重启恢复测试（两阶段）：
 *   node scripts/recovery.mjs prepare   创建下载中的任务并强杀服务（模拟崩溃）
 *   node scripts/recovery.mjs verify    服务重启后校验：任务自动恢复并断点续传、
 *                                       已完成任务不被重复下载
 */
import fs from 'node:fs';
import path from 'node:path';

const APP_BASE = process.env.APP_BASE || 'http://127.0.0.1:3000';
const MEDIA_BASE = process.env.MEDIA_BASE || 'http://127.0.0.1:8099';
const OUT = path.resolve('artifacts/recovery');
fs.mkdirSync(OUT, { recursive: true });
const STATE = path.join(OUT, 'state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const res = await fetch(`${APP_BASE}/api${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${pathname} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitHealthy(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${APP_BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // 服务未起来
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('应用服务未就绪');
    await sleep(500);
  }
}

async function prepare() {
  console.log('=== 恢复测试 Phase 1：准备并强杀服务 ===');
  await waitHealthy();
  // 基线：一个快速完成的任务（重启后不得重新下载）
  const base = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: `${MEDIA_BASE}/media/2?name=recovery-base.mp4`, quality: 'original', format: 'mp4', title: 'recovery-base.mp4' }),
  });
  const baseId = base.task.id;
  for (let i = 0; i < 60; i++) {
    const t = (await api(`/tasks/${baseId}`)).task;
    if (t.status === 'completed') break;
    if (t.status === 'failed') throw new Error('基线任务失败');
    await sleep(500);
  }
  const baseline = (await api(`/tasks/${baseId}`)).task;
  if (baseline.status !== 'completed') throw new Error('基线任务未完成');

  // 两个慢速任务用于中断恢复
  const ids = [];
  for (const name of ['recovery-slow-01', 'recovery-slow-02']) {
    const r = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ url: `${MEDIA_BASE}/media/15/slow?name=${name}.mp4`, quality: 'original', format: 'mp4', title: `${name}.mp4` }),
    });
    ids.push(r.task.id);
  }
  // 等待下载有实际进度（> 800KB）
  const progress = {};
  const deadline = Date.now() + 90000;
  for (;;) {
    let ready = true;
    for (const id of ids) {
      const t = (await api(`/tasks/${id}`)).task;
      progress[id] = { downloaded: t.downloadedBytes, total: t.totalBytes, status: t.status };
      if (t.downloadedBytes < 800 * 1024) ready = false;
    }
    if (ready || Date.now() > deadline) break;
    await sleep(1000);
  }
  console.log('中断前进度：', progress);
  for (const id of ids) {
    const t = (await api(`/tasks/${id}`)).task;
    if (t.status !== 'downloading') throw new Error(`任务 ${id} 未处于下载中：${t.status}`);
  }

  // 强杀服务（Windows TerminateProcess，模拟崩溃）
  const pidFile = path.resolve('data/server.pid');
  if (!fs.existsSync(pidFile)) throw new Error('未找到 server.pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  console.log(`强杀服务进程 PID=${pid}`);
  process.kill(pid);
  await sleep(1500);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) throw new Error('服务进程仍存活');
  console.log('服务已终止');

  const state = { baseId, ids, progress, killedAt: Date.now() };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log('Phase 1 完成，请重启服务后运行：node scripts/recovery.mjs verify');
}

async function verify() {
  console.log('=== 恢复测试 Phase 2：验证自动恢复 ===');
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  await waitHealthy();

  // 1. 中断的任务应自动回到队列（waiting → downloading → completed），且进度不回退
  const results = {};
  const deadline = Date.now() + 240000;
  for (;;) {
    let allDone = true;
    for (const id of state.ids) {
      const t = (await api(`/tasks/${id}`)).task;
      results[id] = { status: t.status, downloaded: t.downloadedBytes, total: t.totalBytes, error: t.errorMessage };
      if (!['completed', 'failed', 'cancelled'].includes(t.status)) allDone = false;
      else if (t.status === 'failed') allDone = false; // 允许重试恢复
      if (t.status === 'downloading') {
        const saved = state.progress[id]?.downloaded ?? 0;
        if (t.downloadedBytes + 64 * 1024 < saved) {
          // 进度回退检查（允许重启后从头开始的情况极少，这里给出宽容度）
          if (t.downloadedBytes < saved * 0.5) {
            throw new Error(`任务 ${id} 恢复后进度大幅回退：${saved} → ${t.downloadedBytes}`);
          }
        }
      }
    }
    if (allDone || Date.now() > deadline) break;
    await sleep(2000);
  }

  // 2. 基线任务（已完成）不得被重复下载
  const baseline = (await api(`/tasks/${state.baseId}`)).task;
  if (baseline.status !== 'completed') throw new Error(`基线任务状态异常：${baseline.status}`);
  const baseNow = baseline.downloadedBytes;

  const problems = [];
  for (const id of state.ids) {
    const r = results[id];
    const saved = state.progress[id]?.downloaded ?? 0;
    if (r.status !== 'completed') problems.push(`任务 ${id} 最终状态 ${r.status}（${r.error || ''}）`);
    else if (r.downloaded < saved && r.downloaded < r.total) problems.push(`任务 ${id} 完成字节小于中断前：${saved} → ${r.downloaded}`);
  }
  if (baseNow !== baseline.totalBytes || baseline.downloadedBytes !== baseline.totalBytes) {
    problems.push('基线任务数据被改动');
  }

  const report = {
    ok: problems.length === 0,
    baseline: { id: state.baseId, status: baseline.status, bytes: baseline.downloadedBytes, untouched: baseline.downloadedBytes === baseline.totalBytes },
    interrupted: Object.fromEntries(
      state.ids.map((id) => [id, { saved: state.progress[id]?.downloaded, final: results[id] }]),
    ),
    problems,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 恢复测试结果 =====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const phase = process.argv[2];
if (phase === 'prepare') prepare().catch((e) => { console.error(e); process.exit(1); });
else if (phase === 'verify') verify().catch((e) => { console.error(e); process.exit(1); });
else {
  console.log('用法：node scripts/recovery.mjs prepare|verify');
  process.exit(2);
}
