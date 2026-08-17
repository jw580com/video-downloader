// 模拟自定义脚本解析源：输入页面 URL，输出元数据 + 直链下载地址 JSON
const pageUrl = process.argv[2] ?? '';
const out = {
  title: `自定义解析源测试视频（${pageUrl.slice(-8)}）`,
  author: 'fixture-parser',
  durationSec: 42,
  url: 'http://127.0.0.1:8099/media/3?name=custom-parsed.mp4',
  sizeBytes: 3 * 1024 * 1024,
  headers: {},
};
console.log(JSON.stringify(out));
