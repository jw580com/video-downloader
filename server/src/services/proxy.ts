import type http from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:']);

/** 本机/局域网测试源直连，不经过代理 */
function bypassProxy(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  ) {
    return true;
  }
  // 内网 IPv4 直连，避免代理无法访问 NAS/局域网媒体源
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/**
 * 规范化代理地址：
 * - `10020` → `http://127.0.0.1:10020`
 * - `127.0.0.1:10020` → `http://127.0.0.1:10020`
 * - 支持 http / https / socks / socks5 / socks5h
 * 非法地址返回空字符串。
 */
export function normalizeProxyUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  let value = String(raw).trim();
  if (!value) return '';
  if (/^\d{1,5}$/.test(value)) value = `http://127.0.0.1:${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  try {
    const u = new URL(value);
    if (!PROXY_PROTOCOLS.has(u.protocol) || !u.hostname) return '';
    // 统一去掉 URL 自动补出的根路径斜杠
    return u.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function isValidProxyUrl(raw: string | null | undefined): boolean {
  if (raw == null || String(raw).trim() === '') return true;
  return normalizeProxyUrl(raw) !== '';
}

export interface ProxyAgentOptions {
  timeoutMs?: number;
}

/**
 * 为一次请求创建代理 Agent；目标为本机/.local 或未配置代理时返回 undefined（直连）。
 * HTTP 目标使用 HttpProxyAgent，HTTPS 目标使用 HttpsProxyAgent，SOCKS 目标共用一个 Agent。
 */
export function createProxyAgent(
  targetUrl: string,
  proxyUrl: string | null | undefined,
  options: ProxyAgentOptions = {},
): http.Agent | undefined {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return undefined;
  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return undefined;
  }
  if (bypassProxy(hostname)) return undefined;
  const proxy = new URL(normalized);
  const agentOptions = options.timeoutMs ? { timeout: options.timeoutMs } : undefined;
  if (proxy.protocol.startsWith('socks')) {
    return new SocksProxyAgent(normalized, agentOptions);
  }
  if (targetUrl.startsWith('https:')) {
    return new HttpsProxyAgent(proxy, agentOptions);
  }
  return new HttpProxyAgent(proxy, agentOptions);
}
