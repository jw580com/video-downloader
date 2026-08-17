// 前端构建包装器：以工作区脚本为入口调用 Vite 构建 API。
// 先切换到 web 目录，保证 Vite / Tailwind 的配置文件解析与标准 `npm run build` 一致。
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve('web');
process.chdir(root);
console.log(`vite build: root=${root}`);
await build({ mode: 'production' });
console.log('vite build done → web/dist');
