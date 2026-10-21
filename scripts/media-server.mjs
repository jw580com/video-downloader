/**
 * 本地测试媒体源：生成确定性字节流的“视频”文件，支持 Range 请求与限速。
 * 用于浏览器自动化测试与压力测试，不依赖外部网络。
 *
 * 路由：
 *   GET/HEAD /media/<MB>[/slow]?name=xxx.mp4&rate=<bytes/s>   确定性媒体流
 *   GET/HEAD /missing                                          404
 *   GET      /forbidden                                        403
 *   GET      /redirect                                         302 → /media/2
 *   GET      /health                                           200
 */
import http from 'node:http';

const PORT = Number(process.env.MEDIA_PORT || 8099);
const HOST = process.env.MEDIA_HOST || '127.0.0.1';
const CHUNK = 64 * 1024;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function patternFill(buf, base) {
  for (let i = 0; i < buf.length; i++) buf[i] = (base + i) & 0xff;
  return buf;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const isHead = req.method === 'HEAD';

  if (u.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(isHead ? undefined : JSON.stringify({ ok: true }));
    return;
  }
  if (u.pathname === '/missing') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(isHead ? undefined : JSON.stringify({ error: 'not found' }));
    return;
  }
  if (u.pathname === '/forbidden') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(isHead ? undefined : JSON.stringify({ error: 'forbidden' }));
    return;
  }
  if (u.pathname === '/redirect') {
    res.writeHead(302, { location: '/media/2' });
    res.end();
    return;
  }
  // 只允许 GET、拒绝 HEAD 的服务器（用于测试解析时的 HEAD → GET 降级）
  if (u.pathname === '/head405') {
    if (isHead) {
      res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' });
      res.end(isHead ? undefined : JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    res.writeHead(302, { location: '/media/1?name=head405.mp4' });
    res.end();
    return;
  }
  // 延迟 4 秒才返回响应头（用于测试“响应前暂停”不会卡住任务）
  if (u.pathname === '/slowheaders') {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(302, { location: '/media/2?name=slowheaders.mp4' });
      res.end();
    }, 4000);
    return;
  }
  // HEAD 正常、GET 中途断流（用于测试下载中断的失败处理）
  if (u.pathname === '/flaky') {
    if (isHead) {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(10 * 1024 * 1024),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(10 * 1024 * 1024),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    const buf = patternFill(Buffer.alloc(CHUNK), 0);
    for (let i = 0; i < 16; i++) {
      if (res.destroyed) break;
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
    }
    res.destroy(); // 模拟网络中断
    return;
  }

  const m = u.pathname.match(/^\/media\/([\d.]+)(?:\/(slow))?$/);
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(isHead ? undefined : JSON.stringify({ error: 'unknown route' }));
    return;
  }
  const mb = Math.min(2048, Math.max(0.01, Number(m[1]) || 1));
  const rate = u.searchParams.get('rate')
    ? Number(u.searchParams.get('rate'))
    : m[2] === 'slow'
      ? 256 * 1024
      : 0;
  const total = Math.round(mb * 1024 * 1024);
  const name = u.searchParams.get('name') || `video-${mb}mb.mp4`;

  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const rm = /bytes=(\d+)-(\d*)/.exec(range);
    if (!rm) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    start = Number(rm[1]);
    if (rm[2]) end = Math.min(Number(rm[2]), total - 1);
    if (start > total - 1) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    status = 206;
  }

  const headers = {
    'content-type': 'video/mp4',
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename="${name}"`,
    'cache-control': 'no-store',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (isHead) {
    res.end();
    return;
  }

  let pos = start;
  let destroyed = false;
  req.on('close', () => {
    destroyed = true;
  });
  try {
    while (pos <= end && !destroyed) {
      const len = Math.min(CHUNK, end - pos + 1);
      const buf = patternFill(Buffer.alloc(len), pos);
      if (!res.write(buf)) {
        await new Promise((r) => res.once('drain', r));
      }
      pos += len;
      if (rate > 0 && len > 0) {
        await sleep((len / rate) * 1000);
      }
    }
    if (!destroyed) res.end();
  } catch {
    // 客户端断开
    try {
      res.destroy();
    } catch {
      // ignore
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[media-server] listening on http://${HOST}:${PORT}`);
});
