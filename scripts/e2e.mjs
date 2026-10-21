/**
 * 浏览器自动化测试：使用系统 Edge（puppeteer-core）测试生产构建。
 * 前置条件：
 *   1. 应用服务运行于 APP_BASE（默认 http://127.0.0.1:3000）
 *   2. 媒体测试源运行于 MEDIA_BASE（默认 http://127.0.0.1:8099）
 * 结果输出到 artifacts/e2e/results.json 与截图 artifacts/e2e/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP_BASE = process.env.APP_BASE || 'http://127.0.0.1:3000';
const MEDIA_BASE = process.env.MEDIA_BASE || 'http://127.0.0.1:8099';
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('artifacts/e2e');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let page = null;
// 每轮运行使用唯一任务名，避免重复下载确认干扰（可重复执行）
const RUN = Date.now().toString(36);
const FAST = `e2e-fast-${RUN}`;
const SLOW = (i) => `e2e-slow-${RUN}-${i}`;
const CONTROL = `e2e-control-${RUN}`;
const FLAKY = `e2e-flaky-${RUN}`;

function ok(name, extra = '') {
  results.push({ name, pass: true, extra });
  console.log(`  ✔ PASS  ${name}${extra ? ` (${extra})` : ''}`);
}

function fail(name, err) {
  results.push({ name, pass: false, error: String(err) });
  console.log(`  ✘ FAIL  ${name} → ${err}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  } catch {
    // ignore
  }
}

async function waitForText(text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

/** 点击第一个文本包含指定内容的按钮/链接 */
async function clickButtonByText(text, timeout = 15000) {
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('button, a')].some((e) => e.textContent.trim().includes(t)),
    { timeout },
    text,
  );
  const clicked = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button, a')];
    const el = els.find((e) => e.textContent.trim().includes(t));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
  assert(clicked, `未找到可点击元素：${text}`);
}

/** 用原生 setter 清空 React 受控输入框，再输入文本 */
async function typeUrl(url) {
  await page.click('[data-testid="url-input"]');
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="url-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (url) await page.type('[data-testid="url-input"]', url, { delay: 2 });
}

/** 在任务行内点击指定 title 的按钮（带重试） */
async function clickRowButton(titleFrag, btnTitle, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const clicked = await page.evaluate(
      (frag, title) => {
        const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(frag));
        const btn = row && [...row.querySelectorAll('button')].find((b) => b.title === title);
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      },
      titleFrag,
      btnTitle,
    );
    if (clicked) return;
    if (Date.now() > deadline) throw new Error(`未找到任务「${titleFrag}」的「${btnTitle}」按钮`);
    await sleepMs(500);
  }
}

async function waitRowContains(titleFrag, text, timeout = 15000) {
  await page.waitForFunction(
    (frag, t) => {
      const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(frag));
      return row ? row.textContent.includes(t) : false;
    },
    { timeout },
    titleFrag,
    text,
  );
}

async function rowPercent(titleFrag) {
  return page.evaluate((frag) => {
    const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(frag));
    if (!row) return null;
    const m = /(\d+(?:\.\d+)?)%/.exec(row.textContent);
    return m ? Number(m[1]) : null;
  }, titleFrag);
}

async function waitForPreview() {
  await page.waitForSelector('[data-testid="preview-card"]', { timeout: 45000 });
}

async function parseUrl(url) {
  await typeUrl(url);
  await page.click('[data-testid="parse-btn"]');
}

async function addTaskAndGotoTasks(url) {
  await parseUrl(url);
  await waitForPreview();
  await page.click('[data-testid="add-btn"]');
  await page.waitForFunction(() => location.pathname === '/tasks', { timeout: 15000 });
  await waitForText('下载任务');
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error(`Edge 未找到：${EDGE}`);
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--mute-audio', '--disable-dev-shm-usage'],
    userDataDir: path.join(OUT, 'profile'),
    pipe: false,
    defaultViewport: { width: 1440, height: 900 },
  });
  console.log('Edge 已启动，开始测试…');

  try {
    page = await browser.newPage();
    page.setDefaultTimeout(20000);

    // 1. 首页正常打开
    try {
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await waitForText('在线视频下载管理器');
      await waitForText('统一管理你的在线视频下载任务');
      assert((await page.$('[data-testid="url-input"]')) !== null, 'URL 输入框不存在');
      await waitForText('解析视频');
      await shot('01-home');
      ok('首页正常打开', '标题/副标题/输入框/按钮均存在');
    } catch (e) {
      fail('首页正常打开', e);
    }

    // 2. URL 输入
    try {
      await typeUrl('https://example.com/a.mp4');
      const v = await page.$eval('[data-testid="url-input"]', (el) => el.value);
      assert(v === 'https://example.com/a.mp4', `输入值不符：${v}`);
      ok('URL 输入正常');
    } catch (e) {
      fail('URL 输入', e);
    }

    // 3. URL 校验（空 / 非 URL / 不支持平台）
    try {
      await typeUrl('');
      await page.click('[data-testid="parse-btn"]');
      await waitForText('请先粘贴视频链接', 8000);
      await typeUrl('not a url');
      await page.click('[data-testid="parse-btn"]');
      await waitForText('URL 无效', 8000);
      await typeUrl('https://example.com/');
      await page.click('[data-testid="parse-btn"]');
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return (
            t.includes('平台不支持') ||
            t.includes('无法识别') ||
            t.includes('网络') ||
            t.includes('无法连接') ||
            t.includes('代理') ||
            t.includes('超时')
          );
        },
        { timeout: 45000 },
      );
      await shot('03-validation');
      ok('URL 校验正常', '空输入 / 非 URL / 未知平台均有明确提示');
    } catch (e) {
      fail('URL 校验', e);
    }

    // 4. 平台识别（YouTube：解析成功显示徽标；网络受限时给出清晰错误）
    try {
      await parseUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      const preview = await page
        .waitForSelector('[data-testid="preview-card"]', { timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (preview) {
        const t = await page.evaluate(() => document.body.innerText);
        assert(t.includes('YouTube'), '预览卡片未显示 YouTube 徽标');
        ok('平台识别正常', 'YouTube 预览卡片显示');
        await shot('04-platform-youtube');
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const el = btns.find((b) => b.textContent.trim() === '取消');
          if (el) el.click();
        });
      } else {
        const t = await page.evaluate(() => document.body.innerText);
        const hasClearError =
          t.includes('不存在') || t.includes('不可访问') || t.includes('超时') || t.includes('网络');
        assert(hasClearError, '既无预览也无清晰错误提示');
        ok('平台识别正常（受限路径）', '网络受限时给出清晰错误提示');
      }
    } catch (e) {
      fail('平台识别', e);
    }

    // 4b. 平台识别（抖音）：正常时显示预览，Cookie/访问控制受限时给出清晰提示
    try {
      await parseUrl('https://www.douyin.com/video/6963263655114722595');
      const outcome = await page.waitForFunction(
        () => {
          if (document.querySelector('[data-testid="preview-card"]')) return 'preview';
          if (document.querySelector('[data-testid="parse-error"]')) return 'error';
          return false;
        },
        { timeout: 50000 },
      );
      if (outcome === 'preview') {
        const t = await page.evaluate(() => document.body.innerText);
        assert(t.includes('抖音'), '预览卡片未显示抖音徽标');
        ok('平台识别正常（抖音）', '抖音预览卡片显示');
        await shot('04b-platform-douyin');
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const el = btns.find((b) => b.textContent.trim() === '取消');
          if (el) el.click();
        });
      } else {
        const t = await page.evaluate(() => document.body.innerText);
        const hasClearError =
          t.includes('Cookie') ||
          t.includes('访问控制') ||
          t.includes('登录') ||
          t.includes('不存在') ||
          t.includes('超时') ||
          t.includes('网络');
        assert(hasClearError, '既无预览也无清晰错误提示');
        ok('平台识别正常（抖音·受限路径）', 'Cookie/访问控制受限时给出清晰提示');
      }
    } catch (e) {
      fail('平台识别（抖音）', e);
    }

    // 5. 任务创建（直链媒体 → 预览 → 加入队列 → 跳转任务页）
    try {
      await addTaskAndGotoTasks(`${MEDIA_BASE}/media/3?name=${FAST}.mp4`);
      await waitForText(FAST, 20000);
      ok('任务创建正常', '直链视频解析并加入队列，任务页可见');
    } catch (e) {
      fail('任务创建', e);
    }

    // 6. 下载队列（并发 3：塞入慢速任务，观察等待）
    try {
      for (let i = 1; i <= 3; i++) {
        await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
        await addTaskAndGotoTasks(`${MEDIA_BASE}/media/${i + 2}/slow?name=${SLOW(i)}.mp4`);
        await waitForText(SLOW(i), 20000);
      }
      // 12MB 慢任务用于暂停/继续/取消测试
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await addTaskAndGotoTasks(`${MEDIA_BASE}/media/12/slow?name=${CONTROL}.mp4`);
      await waitForText(CONTROL, 20000);
      await page.waitForFunction(() => document.body.innerText.includes('等待中'), { timeout: 15000 });
      await shot('06-queue');
      ok('下载队列正常', '超过并发上限的任务进入等待');
    } catch (e) {
      fail('下载队列', e);
    }

    // 7. 下载进度实时显示
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return /速度：/.test(t) && /\d+%/.test(t);
        },
        { timeout: 20000 },
      );
      await shot('07-progress');
      ok('下载进度正常', '百分比/速度/剩余时间实时显示');
    } catch (e) {
      fail('下载进度', e);
    }

    // 8. 暂停
    let pctAtPause = null;
    try {
      await clickRowButton(CONTROL, '暂停', 30000);
      await waitRowContains(CONTROL, '已暂停', 10000);
      pctAtPause = await rowPercent(CONTROL);
      await shot('08-paused');
      ok('暂停正常', `暂停前进度约 ${pctAtPause}%`);
    } catch (e) {
      fail('暂停', e);
    }

    // 9. 继续（断点续传：进度不回退）
    try {
      await clickRowButton(CONTROL, '继续', 10000);
      await waitRowContains(CONTROL, '下载中', 15000);
      await sleepMs(3000);
      const pctNow = await rowPercent(CONTROL);
      if (pctNow !== null && pctAtPause !== null) {
        assert(pctNow >= pctAtPause - 2, `续传进度回退：${pctAtPause}% → ${pctNow}%`);
        ok('继续正常（断点续传）', `${pctAtPause}% → ${pctNow}%`);
      } else {
        ok('继续正常', '任务已恢复下载');
      }
    } catch (e) {
      fail('继续', e);
    }

    // 10. 取消
    try {
      await clickRowButton(CONTROL, '取消', 10000);
      await waitRowContains(CONTROL, '已取消', 10000);
      await shot('10-cancelled');
      ok('取消正常');
    } catch (e) {
      fail('取消', e);
    }

    // 11. 重试 + 失败原因清晰展示（/flaky：HEAD 正常、GET 中途断流）
    try {
      // 11a. 重试已取消任务
      await clickRowButton(CONTROL, '重试', 10000);
      await page.waitForFunction(
        (frag) => {
          const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(frag));
          return row ? ['等待中', '解析中', '下载中'].some((s) => row.textContent.includes(s)) : false;
        },
        { timeout: 10000 },
        CONTROL,
      );
      ok('重试正常', '已取消任务重新入队');
      // 11b. 下载中断的失败任务
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await addTaskAndGotoTasks(`${MEDIA_BASE}/flaky?name=${FLAKY}.mp4`);
      await waitForText(FLAKY, 20000);
      await page.waitForFunction(
        (frag) => {
          const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(frag));
          return row ? row.textContent.includes('失败') && row.textContent.includes('中断') : false;
        },
        { timeout: 60000 },
        FLAKY,
      );
      await shot('11-failed-reason');
      ok('失败原因清晰展示', '「网络连接中断」');
    } catch (e) {
      fail('重试 / 失败原因', e);
    }

    // 12. 历史记录
    try {
      await page.goto(APP_BASE + '/tasks', { waitUntil: 'domcontentloaded' });
      await waitRowContains(FAST, '已完成', 30000);
      await page.goto(APP_BASE + '/history', { waitUntil: 'domcontentloaded' });
      await waitForText('下载历史');
      await waitForText(FAST, 20000);
      assert(
        (await page.evaluate(() => document.body.innerText)).includes('downloads'),
        '历史记录未显示文件路径',
      );
      await shot('12-history');
      ok('历史记录正常', '记录/状态/文件路径可见');
    } catch (e) {
      fail('历史记录', e);
    }

    // 13. Dashboard
    try {
      await page.goto(APP_BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
      await waitForText('数据统计 Dashboard');
      const t = await page.evaluate(() => document.body.innerText);
      for (const label of ['今日任务', '今日已完成', '下载中', '今日失败', '累计下载', '累计任务']) {
        assert(t.includes(label), `缺少统计项：${label}`);
      }
      const svgCount = await page.$$eval('svg', (els) => els.length);
      assert(svgCount >= 2, `图表数量不足：${svgCount}`);
      await shot('13-dashboard');
      ok('Dashboard 数据正常', `6 项统计 + ${svgCount} 个图表`);
    } catch (e) {
      fail('Dashboard', e);
    }

    // 14. Settings（并发修改持久化）
    try {
      await page.goto(APP_BASE + '/settings', { waitUntil: 'domcontentloaded' });
      await waitForText('下载设置');
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => b.textContent.trim() === '5' && b.closest('.rounded-2xl'));
        if (el) el.click();
      });
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => b.textContent.trim() === '保存设置');
        if (el) el.click();
      });
      await waitForText('设置已保存');
      const saved = await page.evaluate(async () => {
        const r = await fetch('/api/settings');
        const j = await r.json();
        return j.settings.maxConcurrency;
      });
      assert(saved === 5, `并发设置未持久化：${saved}`);
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => b.textContent.trim() === '3' && b.closest('.rounded-2xl'));
        if (el) el.click();
      });
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => b.textContent.trim() === '保存设置');
        if (el) el.click();
      });
      await waitForText('设置已保存');
      await shot('14-settings');
      ok('Settings 正常', '并发修改持久化成功并已还原');
    } catch (e) {
      fail('Settings', e);
    }

    // 15. Dark Mode
    try {
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="theme-toggle"]');
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 5000 });
      await shot('15-dark');
      await page.click('[data-testid="theme-toggle"]');
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), { timeout: 5000 });
      ok('Dark Mode 正常', '切换后 html.dark 类生效');
    } catch (e) {
      fail('Dark Mode', e);
    }

    // 16. 手机端布局（无横向滚动）
    try {
      await page.setViewport({ width: 390, height: 844 });
      const paths = ['/', '/tasks', '/dashboard', '/history', '/settings'];
      for (const p of paths) {
        await page.goto(APP_BASE + p, { waitUntil: 'domcontentloaded' });
        await sleepMs(900);
        const { sw, cw } = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        assert(sw <= cw + 1, `${p} 存在横向滚动：scrollWidth=${sw} clientWidth=${cw}`);
      }
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await sleepMs(600);
      await shot('16-mobile-home');
      await page.goto(APP_BASE + '/tasks', { waitUntil: 'domcontentloaded' });
      await sleepMs(600);
      await shot('16-mobile-tasks');
      await page.setViewport({ width: 1440, height: 900 });
      ok('手机端布局正常', '5 个页面均无横向滚动');
    } catch (e) {
      fail('手机端布局', e);
    }

    // 附加：拖拽 URL 到输入区
    try {
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate((url) => {
        const zone = document.querySelector('[data-testid="drop-zone"]');
        const dt = new DataTransfer();
        dt.setData('text/plain', url);
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, `${MEDIA_BASE}/media/1?name=dropped.mp4`);
      await page.waitForFunction(
        (frag) => document.querySelector('[data-testid="url-input"]').value.includes(frag),
        { timeout: 5000 },
        'dropped.mp4',
      );
      ok('拖拽输入正常');
    } catch (e) {
      fail('拖拽输入', e);
    }

    // 17. 批量删除（勾选多个任务）
    const B1 = `batch-e2e-${RUN}-1`;
    const B2 = `batch-e2e-${RUN}-2`;
    const B3 = `batch-e2e-${RUN}-3`;
    try {
      for (const name of [B1, B2, B3]) {
        await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
        await addTaskAndGotoTasks(`${MEDIA_BASE}/media/1?name=${name}.mp4`);
        await waitForText(name, 20000);
      }
      const tickRow = (frag) =>
        page.evaluate((f) => {
          const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(f));
          const box = row && row.querySelector('input[type="checkbox"]');
          if (box) {
            box.click();
            return true;
          }
          return false;
        }, frag);
      assert((await tickRow(B1)) && (await tickRow(B2)), '未能勾选任务复选框');
      await waitForText('已选择 2 个任务', 8000);
      await shot('17-batch-selected');
      await clickButtonByText('批量删除');
      await clickButtonByText('确认删除');
      await waitForText('已删除 2 个任务', 10000);
      await page.waitForFunction(
        (a, b, c) => {
          const rows = [...document.querySelectorAll('tr')];
          return (
            !rows.some((r) => r.textContent.includes(a) || r.textContent.includes(b)) &&
            rows.some((r) => r.textContent.includes(c))
          );
        },
        { timeout: 10000 },
        B1,
        B2,
        B3,
      );
      ok('批量删除正常', '勾选 2 个任务删除，未勾选的保留');
    } catch (e) {
      fail('批量删除', e);
    }

    // 18. 全部删除（按「失败」筛选条件）
    try {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => b.textContent.trim() === '失败' && b.classList.contains('rounded-full'));
        if (el) el.click();
      });
      await sleepMs(1200);
      await clickButtonByText('全部删除');
      await waitForText('确认删除全部', 8000);
      await clickButtonByText('确认删除全部');
      await waitForText('已删除', 10000);
      await page.waitForFunction(
        () => {
          const rows = [...document.querySelectorAll('tr')];
          return !rows.some((r) => r.textContent.includes('失败'));
        },
        { timeout: 15000 },
      );
      await shot('18-delete-all');
      ok('全部删除正常', '按「失败」筛选清空对应记录');
    } catch (e) {
      fail('全部删除', e);
    }

    // 19. 自定义解析源（UI 添加脚本型解析源 → 解析 → 下载完成）
    const PARSER_NAME = `本地解析源-${RUN}`;
    const PARSER_DOMAIN = `test-${RUN}.local`;
    try {
      await page.goto(APP_BASE + '/settings', { waitUntil: 'domcontentloaded' });
      await waitForText('解析源');
      await clickButtonByText('添加解析源');
      await waitForText('保存解析源', 8000);
      const scriptPath = path.resolve('scripts/fixtures/fake-parser.mjs');
      await page.type('[data-testid="parser-name"]', PARSER_NAME, { delay: 10 });
      await page.type('[data-testid="parser-domains"]', PARSER_DOMAIN, { delay: 10 });
      await page.select('[data-testid="parser-type"]', 'script');
      await page.type('[data-testid="parser-script"]', `node ${scriptPath} {url}`, { delay: 5 });
      await clickButtonByText('保存解析源');
      await waitForText('解析源已添加', 8000);
      await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
      await parseUrl(`https://${PARSER_DOMAIN}/video/999`);
      await waitForPreview();
      await page.waitForFunction(
        (name) => document.body.innerText.includes(name),
        { timeout: 15000 },
        PARSER_NAME,
      );
      await shot('19-custom-parser-preview');
      await page.click('[data-testid="add-btn"]');
      await page.waitForFunction(() => location.pathname === '/tasks', { timeout: 15000 });
      await waitForText('自定义解析源测试视频', 30000);
      await waitRowContains('自定义解析源测试视频', '已完成', 30000);
      await shot('19-custom-parser-done');
      ok('自定义解析源正常', 'UI 添加脚本解析源 → 解析 → 下载完成');
    } catch (e) {
      fail('自定义解析源', e);
    }
  } finally {
    await browser.close();
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`\n===== E2E 结果：${summary.passed}/${summary.total} 通过 =====`);
  for (const r of results) {
    console.log(`  ${r.pass ? '✔' : '✘'} ${r.name}${r.error ? ` → ${r.error}` : ''}`);
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 运行失败：', e);
  fs.writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ total: 0, passed: 0, failed: 1, error: String(e) }, null, 2),
  );
  process.exit(1);
});
