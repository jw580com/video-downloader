// 开发模式前端入口：以工作区脚本启动 Vite dev server（沙箱友好）
import path from 'node:path';
import { createServer } from 'vite';

process.chdir(path.resolve('web'));
const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } });
await server.listen();
console.log('[vite-dev] http://127.0.0.1:5173');
