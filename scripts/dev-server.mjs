// 开发模式服务端入口：node --watch + tsx loader（沙箱友好，无需 npm 包装器）
// 用法：node --watch scripts/dev-server.mjs
import 'tsx/esm';
await import('../server/src/index.ts');
