import crypto from 'node:crypto';
import type { DB } from './database.js';
import { nowMs } from '../util.js';

export type ParserType = 'ytdlp' | 'script';

export interface ParserRow {
  id: string;
  name: string;
  domains: string;
  type: ParserType;
  enabled: boolean;
  ytdlpArgs: string;
  headers: string;
  script: string;
  cookiesFile: string;
  createdAt: number;
}

export interface NewParser {
  name: string;
  domains: string;
  type: ParserType;
  enabled: boolean;
  ytdlpArgs: string;
  headers: string;
  script: string;
  cookiesFile: string;
}

interface RawRow {
  [key: string]: unknown;
}

function toParser(r: RawRow): ParserRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    domains: String(r.domains ?? ''),
    type: r.type === 'script' ? 'script' : 'ytdlp',
    enabled: Number(r.enabled ?? 1) === 1,
    ytdlpArgs: String(r.ytdlp_args ?? ''),
    headers: String(r.headers ?? ''),
    script: String(r.script ?? ''),
    cookiesFile: String(r.cookies_file ?? ''),
    createdAt: Number(r.created_at ?? 0),
  };
}

export function listParsers(db: DB): ParserRow[] {
  const rows = db.prepare('SELECT * FROM parsers ORDER BY created_at ASC').all() as RawRow[];
  return rows.map(toParser);
}

export function getParser(db: DB, id: string): ParserRow | undefined {
  const row = db.prepare('SELECT * FROM parsers WHERE id = ?').get(id) as RawRow | undefined;
  return row ? toParser(row) : undefined;
}

export function createParser(db: DB, p: NewParser): ParserRow {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO parsers (id, name, domains, type, enabled, ytdlp_args, headers, script, cookies_file, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    p.name,
    p.domains,
    p.type,
    p.enabled ? 1 : 0,
    p.ytdlpArgs,
    p.headers,
    p.script,
    p.cookiesFile,
    nowMs(),
  );
  return getParser(db, id)!;
}

export function updateParser(db: DB, id: string, patch: Partial<NewParser>): ParserRow | undefined {
  const cur = getParser(db, id);
  if (!cur) return undefined;
  const next: NewParser = {
    name: patch.name ?? cur.name,
    domains: patch.domains ?? cur.domains,
    type: patch.type ?? cur.type,
    enabled: patch.enabled ?? cur.enabled,
    ytdlpArgs: patch.ytdlpArgs ?? cur.ytdlpArgs,
    headers: patch.headers ?? cur.headers,
    script: patch.script ?? cur.script,
    cookiesFile: patch.cookiesFile ?? cur.cookiesFile,
  };
  db.prepare(
    `UPDATE parsers SET name=?, domains=?, type=?, enabled=?, ytdlp_args=?, headers=?, script=?, cookies_file=? WHERE id=?`,
  ).run(
    next.name,
    next.domains,
    next.type,
    next.enabled ? 1 : 0,
    next.ytdlpArgs,
    next.headers,
    next.script,
    next.cookiesFile,
    id,
  );
  return getParser(db, id);
}

export function deleteParser(db: DB, id: string): void {
  db.prepare('DELETE FROM parsers WHERE id = ?').run(id);
}

export function domainList(p: ParserRow): string[] {
  return p.domains
    .split(/[,，\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
}

/** 按主机名匹配自定义解析源（精确或子域名匹配，内置平台优先于自定义解析源） */
export function findParserForHost(db: DB, hostname: string): ParserRow | undefined {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const p of listParsers(db)) {
    if (!p.enabled) continue;
    for (const d of domainList(p)) {
      if (host === d || host.endsWith(`.${d}`)) return p;
    }
  }
  return undefined;
}
