// 类型检查包装器：沙箱禁止直接以 node_modules 内脚本作为进程入口，
// 通过本工作区脚本间接加载 TypeScript 编译器。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.argv = ['node', 'tsc', ...process.argv.slice(2)];
require('../node_modules/typescript/lib/tsc.js');
