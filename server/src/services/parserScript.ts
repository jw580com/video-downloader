import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { tailOfFile } from '../util.js';

export interface ScriptParserOutput {
  title?: string;
  thumbnail?: string;
  author?: string;
  durationSec?: number;
  url: string;
  sizeBytes?: number;
  headers?: Record<string, string>;
}

/** 命令模板分词：支持单/双引号包裹含空格的参数 */
export function tokenizeTemplate(template: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * 运行用户自定义脚本解析源。
 * 约定：脚本在标准输出打印一行 JSON：
 * { title?, thumbnail?, author?, durationSec?, url(必填, 直链地址), sizeBytes?, headers? }
 * 命令模板中可用 {url} 占位符；未出现占位符时自动把页面 URL 作为最后一个参数。
 */
export async function runScriptParser(
  template: string,
  pageUrl: string,
  timeoutMs = 30000,
  label = '自定义解析源',
): Promise<ScriptParserOutput> {
  const tokens = tokenizeTemplate(template);
  if (tokens.length === 0) throw new AppError('BAD_REQUEST', '脚本命令为空');
  const hasUrl = tokens.some((t) => t.includes('{url}'));
  const replaced = tokens.map((t) => t.split('{url}').join(pageUrl));
  const cmd = replaced[0];
  const args = hasUrl ? replaced.slice(1) : [...replaced.slice(1), pageUrl];

  const token = crypto.randomBytes(6).toString('hex');
  const outFile = path.join(config.dataDir, 'logs', `script-${token}.out`);
  const errFile = `${outFile}.log`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(cmd, args, {
          stdio: ['ignore', fdOut, fdErr],
          windowsHide: true,
        });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new AppError('TIMEOUT', `${label} 执行超时`));
      }, timeoutMs);
      proc.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === 'ENOENT'
            ? new AppError('VIDEO_UNAVAILABLE', `${label} 命令不存在：${cmd}`)
            : new AppError('VIDEO_UNAVAILABLE', `${label} 无法启动（${e.code ?? e.message}）`),
        );
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) {
      const tail = tailOfFile(errFile).trim().slice(-300);
      throw new AppError('VIDEO_UNAVAILABLE', `${label} 执行失败${tail ? `（${tail}）` : ''}`);
    }
    const text = fs.readFileSync(outFile, 'utf8').trim();
    if (!text) throw new AppError('VIDEO_UNAVAILABLE', `${label} 未输出任何结果`);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AppError('VIDEO_UNAVAILABLE', `${label} 输出不是合法 JSON`);
    }
    const obj = data as Record<string, unknown>;
    const outUrl = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!/^https?:\/\//i.test(outUrl)) {
      throw new AppError('VIDEO_UNAVAILABLE', `${label} 输出缺少合法的直链 url 字段`);
    }
    return {
      title: typeof obj.title === 'string' ? obj.title : undefined,
      thumbnail: typeof obj.thumbnail === 'string' ? obj.thumbnail : undefined,
      author: typeof obj.author === 'string' ? obj.author : undefined,
      durationSec: typeof obj.durationSec === 'number' ? Math.round(obj.durationSec) : 0,
      url: outUrl,
      sizeBytes: typeof obj.sizeBytes === 'number' && obj.sizeBytes > 0 ? obj.sizeBytes : undefined,
      headers:
        obj.headers && typeof obj.headers === 'object'
          ? (obj.headers as Record<string, string>)
          : undefined,
    };
  } finally {
    try {
      fs.closeSync(fdOut);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(fdErr);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(errFile);
    } catch {
      // ignore
    }
  }
}
