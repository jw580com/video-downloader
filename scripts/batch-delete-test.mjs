import fs from 'node:fs';
const APP = 'http://127.0.0.1:3000';
const MEDIA = 'http://127.0.0.1:8099';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => {
  const res = await fetch(APP + '/api' + p, { headers: { 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
let ok = true;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) ok = false;
};

const stamp = Date.now().toString(36);
const mk = async (name, size = 1) => {
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: `${MEDIA}/media/${size}?name=${name}.mp4`, quality: 'original', format: 'mp4', title: `${name}.mp4` }),
  });
  return r.body.task.id;
};
const waitDone = async (id) => {
  let t;
  for (let i = 0; i < 40; i++) {
    t = (await api(`/tasks/${id}`)).body.task;
    if (['completed', 'failed', 'cancelled'].includes(t.status)) return t;
    await sleep(250);
  }
  return t;
};

console.log('=== 批量删除 API 验证 ===');

// 1. 创建 3 个完成任务
const ids = [];
for (let i = 1; i <= 3; i++) ids.push(await mk(`batch-${stamp}-${i}`));
for (const id of ids) await waitDone(id);
const files = [];
for (const id of ids) files.push((await api(`/tasks/${id}`)).body.task.filePath);
console.log('1. 创建 3 个完成任务，文件存在:', files.every((f) => fs.existsSync(f)));

// 2. 批量删除（不删文件）
const r1 = await api('/tasks/batch-delete', { method: 'POST', body: JSON.stringify({ ids: [ids[0], ids[1]], withFiles: false }) });
check('批量删除(仅记录)', r1.status === 200 && r1.body.deleted === 2 && r1.body.filesDeleted === 0, JSON.stringify(r1.body));
check('记录已删', (await api(`/tasks/${ids[0]}`)).status === 404 && (await api(`/tasks/${ids[1]}`)).status === 404);
check('文件保留', fs.existsSync(files[0]) && fs.existsSync(files[1]));

// 3. 批量删除（同时删文件）
const r2 = await api('/tasks/batch-delete', { method: 'POST', body: JSON.stringify({ ids: [ids[2]], withFiles: true }) });
check('批量删除(含文件)', r2.status === 200 && r2.body.deleted === 1 && r2.body.filesDeleted === 1, JSON.stringify(r2.body));
check('文件已删', !fs.existsSync(files[2]));
// 清理保留的文件
for (const f of files.slice(0, 2)) if (fs.existsSync(f)) fs.unlinkSync(f);

// 4. 非法参数
const bad = await api('/tasks/batch-delete', { method: 'POST', body: JSON.stringify({ ids: [], withFiles: false }) });
check('空 ids 被拒绝', bad.status === 400, bad.body.error?.message);
const bad2 = await api('/tasks/batch-delete', { method: 'POST', body: JSON.stringify({ ids: 'not-array' }) });
check('非数组被拒绝', bad2.status === 400);

// 5. 全部删除（带筛选条件）
const a1 = await mk(`all-${stamp}-ok-1`);
const a2 = await mk(`all-${stamp}-ok-2`);
await waitDone(a1);
await waitDone(a2);
const f1 = (await api(`/tasks/${a1}`)).body.task.filePath;
const f2 = (await api(`/tasks/${a2}`)).body.task.filePath;
const r3 = await api('/tasks/delete-all', {
  method: 'POST',
  body: JSON.stringify({ withFiles: false, search: `all-${stamp}-ok` }),
});
check('全部删除(按搜索条件)', r3.status === 200 && r3.body.deleted === 2 && r3.body.filesDeleted === 0, JSON.stringify(r3.body));
check('记录已删且文件保留', (await api(`/tasks/${a1}`)).status === 404 && fs.existsSync(f1) && fs.existsSync(f2));
if (fs.existsSync(f1)) fs.unlinkSync(f1);
if (fs.existsSync(f2)) fs.unlinkSync(f2);

// 6. 全部删除运行中的任务（先取消再删）
const active = await mk(`all-${stamp}-active`, 8);
const big = `${MEDIA}/media/8/slow?name=all-${stamp}-active.mp4`;
const c = await api('/tasks', { method: 'POST', body: JSON.stringify({ url: big, quality: 'original', format: 'mp4', title: `all-${stamp}-active.mp4` }) });
const r4 = await api('/tasks/delete-all', { method: 'POST', body: JSON.stringify({ withFiles: true, search: `all-${stamp}-active` }) });
check('全部删除(含运行中任务)', r4.status === 200 && r4.body.deleted === 2, JSON.stringify(r4.body));
check('运行中任务记录已删', (await api(`/tasks/${active}`)).status === 404 && (await api(`/tasks/${c.body.task.id}`)).status === 404);
// .part 文件应被清理（异步，稍等）
await sleep(1500);
const leftovers = fs.readdirSync('downloads').filter((f) => f.includes(`all-${stamp}-active`));
check('部分下载文件已清理', leftovers.length === 0, leftovers.join(', '));

console.log(ok ? '\n=== 批量删除 API 全部通过 ===' : '\n=== 存在失败项 ===');
process.exit(ok ? 0 : 1);
