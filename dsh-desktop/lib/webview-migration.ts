/** Electron -> Tauri WebView storage handoff. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WEBVIEW_MIGRATION_SCHEMA = 1;
export const WEBVIEW_MIGRATION_FILE = 'webview-migration.json';

export interface IndexedDbStoreExport {
  readonly name: string;
  readonly keyPath: string | string[] | null;
  readonly autoIncrement: boolean;
  readonly records: readonly { readonly key: unknown; readonly value: unknown }[];
}

export interface IndexedDbExport {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly IndexedDbStoreExport[];
}

export interface WebViewCookieExport {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expirationDate?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: string;
}

export interface WebViewStorageExport {
  readonly schemaVersion: 1;
  readonly source: 'electron';
  readonly createdAt: string;
  readonly origin: string;
  readonly localStorage: Readonly<Record<string, string>>;
  readonly indexedDb: readonly IndexedDbExport[];
  readonly cookies: readonly WebViewCookieExport[];
  readonly checksum: string;
}

interface RendererStoragePayload {
  readonly localStorage?: unknown;
  readonly indexedDb?: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function migrationChecksum(value: Omit<WebViewStorageExport, 'checksum'>): string {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeLocalStorage(value: unknown): Record<string, string> {
  const input = safeRecord(value);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (key.length > 1024 || typeof item !== 'string' || item.length > 1024 * 1024) continue;
    output[key] = item;
  }
  return output;
}

function normalizeIndexedDb(value: unknown): IndexedDbExport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((database) => {
    const db = safeRecord(database);
    const name = String(db.name ?? '');
    if (!name || name.length > 256 || !Array.isArray(db.stores)) return [];
    const stores = db.stores.flatMap((store) => {
      const item = safeRecord(store);
      const storeName = String(item.name ?? '');
      if (!storeName || storeName.length > 256 || !Array.isArray(item.records)) return [];
      const keyPath = item.keyPath === null || typeof item.keyPath === 'string' ||
        (Array.isArray(item.keyPath) && item.keyPath.every((entry) => typeof entry === 'string'))
        ? item.keyPath as string | string[] | null
        : null;
      const records = item.records.flatMap((record) => {
        const r = safeRecord(record);
        if (!('key' in r) || !('value' in r)) return [];
        return [{ key: r.key, value: r.value }];
      });
      return [{
        name: storeName,
        keyPath,
        autoIncrement: item.autoIncrement === true,
        records,
      }];
    });
    return [{ name, version: Number.isFinite(Number(db.version)) ? Number(db.version) : 1, stores }];
  });
}

function normalizeCookies(value: unknown): WebViewCookieExport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((cookie) => {
    const item = safeRecord(cookie);
    const name = String(item.name ?? '');
    const domain = String(item.domain ?? '');
    const cookiePath = String(item.path ?? '/');
    if (!name || !domain || name.length > 4096 || String(item.value ?? '').length > 1024 * 1024) return [];
    const result: WebViewCookieExport = {
      url: String(item.url ?? ''),
      name,
      value: String(item.value ?? ''),
      domain,
      path: cookiePath,
      secure: item.secure === true,
      httpOnly: item.httpOnly === true,
      ...(typeof item.expirationDate === 'number' ? { expirationDate: item.expirationDate } : {}),
      ...(typeof item.sameSite === 'string' ? { sameSite: item.sameSite } : {}),
    };
    return [result];
  });
}

export function buildWebViewMigration(
  origin: string,
  renderer: RendererStoragePayload,
  cookies: unknown,
  now = new Date(),
): WebViewStorageExport {
  const base: Omit<WebViewStorageExport, 'checksum'> = {
    schemaVersion: WEBVIEW_MIGRATION_SCHEMA,
    source: 'electron',
    createdAt: now.toISOString(),
    origin,
    localStorage: normalizeLocalStorage(renderer.localStorage),
    indexedDb: normalizeIndexedDb(renderer.indexedDb),
    cookies: normalizeCookies(cookies),
  };
  return { ...base, checksum: migrationChecksum(base) };
}

export function writeWebViewMigration(
  userDataDir: string,
  value: WebViewStorageExport,
): string {
  const target = path.join(userDataDir, WEBVIEW_MIGRATION_FILE);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows ACLs are inherited. */ }
  return target;
}

export function persistWebViewMigration(
  userDataDir: string,
  origin: string,
  renderer: RendererStoragePayload,
  cookies: unknown,
  now = new Date(),
): string {
  const value = buildWebViewMigration(origin, renderer, cookies, now);
  return writeWebViewMigration(userDataDir, value);
}
