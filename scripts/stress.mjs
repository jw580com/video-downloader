/**
 * 压力测试：20 个任务同时入队。
 * 检查：并发限制、任务状态流转、失败处理、文件落盘、暂停/继续/取消。
 * 结果输出到 artifacts/stress/report.json
 */
import fs from 'node:fs';
import path from 'node:path';

const APP_BASE = process.env.APP_BASE || 'http://127.0.0.1:3000';
const MEDIA_BASE = process.env.MEDIA_BASE || 'http://127.0.0.1:8099';
const OUT = path.resolve('artifacts/stress');
fs.mkdirSync(OUT, { recursive: true });

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

async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${APP_BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // ignore
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('应用服务未就绪');
    await sleep(500);
  }
}

async function main() {
  console.log('=== 压力测试：20 任务并发入队 ===');
  await waitHealthy();
  const { settings } = await api('/settings');
  const maxConcurrency = settings.maxConcurrency;
  console.log(`当前最大并发：${maxConcurrency}`);

  // 构造 20 个任务
  const specs = [];
  for (let i = 1; i <= 6; i++) specs.push({ url: `${MEDIA_BASE}/media/${1 + (i % 4)}/slow?name=stress-slow-${String(i).padStart(2, '0')}.mp4`, expect: 'completed' });
  for (let i = 1; i <= 8; i++) specs.push({ url: `${MEDIA_BASE}/media/${4 + ((i * 3) % 15)}?rate=4194304&name=stress-fast-${String(i).padStart(2, '0')}.mp4`, expect: 'completed' });
  for (let i = 1; i <= 4; i++) specs.push({ url: `${MEDIA_BASE}/missing?name=stress-missing-${String(i).padStart(2, '0')}.mp4`, expect: 'failed' });
  for (let i = 1; i <= 2; i++) specs.push({ url: `${MEDIA_BASE}/media/1?name=stress-tiny-${String(i).padStart(2, '0')}.mp4`, expect: 'completed' });

  const created = [];
  const t0 = Date.now();
  for (const s of specs) {
    const { task } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        url: s.url,
        quality: 'original',
        format: 'mp4',
        title: path.basename(s.url.split('?')[0]) + ' ' + s.url.match(/name=([^&]+)/)[1].replace('.mp4', ''),
        totalBytes: 0,
      }),
    });
    created.push({ ...s, id: task.id });
    console.log(`  创建任务 ${task.id.slice(0, 8)} ${s.expect} <- ${s.url.split('?')[1]}`);
  }
  console.log(`20 个任务已全部入队，耗时 ${Date.now() - t0}ms，开始轮询…`);

  // 轮询监控
  let maxDownloading = 0;
  let maxWaiting = 0;
  let pauseResumeTested = false;
  let cancelTested = false;
  const timeline = [];
  const startAt = Date.now();
  const deadline = startAt + 300000;

  while (Date.now() < deadline) {
    const { items } = await api('/tasks?limit=500');
    const ours = items.filter((t) => created.some((c) => c.id === t.id));
    const downloading = ours.filter((t) => t.status === 'downloading').length;
    const waiting = ours.filter((t) => t.status === 'waiting').length;
    maxDownloading = Math.max(maxDownloading, downloading);
    maxWaiting = Math.max(maxWaiting, waiting);
    timeline.push({ t: Math.round((Date.now() - startAt) / 1000), downloading, waiting, total: ours.length });

    // 暂停/继续测试：选一个慢速任务，下载到 ~20% 时暂停
    if (!pauseResumeTested) {
      const slow = ours.find(
        (t) => t.title.includes('stress-slow-01') && t.status === 'downloading' && t.totalBytes > 0 && t.downloadedBytes / t.totalBytes > 0.2,
      );
      if (slow) {
        console.log(`  [控制] 暂停 stress-slow-01 @ ${Math.round((slow.downloadedBytes / slow.totalBytes) * 100)}%`);
        await api(`/tasks/${slow.id}/pause`, { method: 'POST' });
        await sleep(800);
        const paused = (await api(`/tasks/${slow.id}`)).task;
        if (paused.status !== 'paused') throw new Error('暂停未生效');
        const saved = paused.downloadedBytes;
        console.log(`  [控制] 继续 stress-slow-01（已下载 ${saved} 字节）`);
        await api(`/tasks/${slow.id}/resume`, { method: 'POST' });
        // 恢复后可能先进入等待（并发槽位占用中），等待其真正恢复下载
        let resumed;
        for (let i = 0; i < 90; i++) {
          resumed = (await api(`/tasks/${slow.id}`)).task;
          if (['downloading', 'completed', 'failed'].includes(resumed.status)) break;
          await sleep(500);
        }
        if (!['downloading', 'completed'].includes(resumed.status)) {
          throw new Error(`继续未生效：${resumed.status}（${resumed.errorMessage || ''}）`);
        }
        if (resumed.status === 'downloading' && resumed.downloadedBytes < saved) {
          throw new Error(`续传进度回退：${saved} → ${resumed.downloadedBytes}`);
        }
        console.log(`  [控制] 断点续传 OK：${saved} → ${resumed.downloadedBytes}（${resumed.status}）`);
        pauseResumeTested = true;
      }
    }

    // 取消测试：取消一个中速任务
    if (!cancelTested) {
      const fast = ours.find(
        (t) => t.title.includes('stress-fast-03') && ['downloading', 'waiting'].includes(t.status),
      );
      if (fast) {
        console.log(`  [控制] 取消 stress-fast-03`);
        await api(`/tasks/${fast.id}/cancel`, { method: 'POST' });
        await sleep(800);
        const cancelled = (await api(`/tasks/${fast.id}`)).task;
        if (cancelled.status !== 'cancelled') throw new Error('取消未生效');
        console.log(`  [控制] 取消 OK`);
        cancelTested = true;
      }
    }

    const terminal = ours.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status)).length;
    const done = ours.every((t) => ['completed', 'failed', 'cancelled'].includes(t.status));
    if ((Date.now() - startAt) % 10000 < 1500 || done) {
      console.log(
        `  t=${Math.round((Date.now() - startAt) / 1000)}s 下载中=${downloading} 等待=${waiting} 终态=${terminal}/${ours.length}`,
      );
    }
    if (done) break;
    await sleep(1000);
  }

  // 汇总断言
  const { items } = await api('/tasks?limit=500');
  const ours = items.filter((t) => created.some((c) => c.id === t.id));
  const completed = ours.filter((t) => t.status === 'completed');
  const failed = ours.filter((t) => t.status === 'failed');
  const cancelled = ours.filter((t) => t.status === 'cancelled');
  const slow01 = ours.find((t) => t.title.includes('stress-slow-01'));

  const problems = [];
  if (maxDownloading > maxConcurrency) problems.push(`并发超限：最大 ${maxDownloading} > ${maxConcurrency}`);
  if (completed.length !== 15) problems.push(`完成数不符：${completed.length} != 15（预期 16 个可下载任务中 1 个被取消）`);
  if (failed.length !== 4) problems.push(`失败数不符：${failed.length} != 4`);
  if (cancelled.length !== 1) problems.push(`取消数不符：${cancelled.length} != 1`);
  if (!pauseResumeTested) problems.push('暂停/继续未被测试到');
  if (!cancelTested) problems.push('取消未被测试到');
  for (const f of failed) {
    if (!f.errorMessage) problems.push(`失败任务缺少原因：${f.title}`);
  }
  // 文件落盘检查
  let fileOk = 0;
  let fileMissing = 0;
  for (const t of completed) {
    if (t.filePath && fs.existsSync(t.filePath) && fs.statSync(t.filePath).size === t.totalBytes) fileOk++;
    else {
      fileMissing++;
      problems.push(`文件校验失败：${t.title} (${t.filePath})`);
    }
  }
  // 已取消任务不应留下文件
  for (const t of cancelled) {
    if (t.filePath && fs.existsSync(t.filePath)) problems.push(`取消任务残留文件：${t.title}`);
  }

  const report = {
    ok: problems.length === 0,
    maxConcurrency,
    maxDownloading,
    maxWaiting,
    durationSec: Math.round((Date.now() - startAt) / 1000),
    counts: { completed: completed.length, failed: failed.length, cancelled: cancelled.length, total: ours.length },
    fileChecks: { ok: fileOk, missing: fileMissing },
    pauseResume: { tested: pauseResumeTested, slow01FinalStatus: slow01?.status, slow01Bytes: slow01?.downloadedBytes },
    failedReasons: failed.map((f) => ({ title: f.title, code: f.errorCode, message: f.errorMessage })),
    timeline: timeline.filter((_, i) => i % 5 === 0),
    problems,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 压力测试结果 =====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('压力测试失败：', e);
  process.exit(1);
});
