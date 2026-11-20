// Test helpers: an in-memory "internet" for fetchSafe, with no network access.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike, FetchLikeInit } from '../../server/site/fetchSafe.js';
import type { ResolveAll } from '../../server/site/ssrf.js';

export const fixture = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)), 'utf8');

export interface MockRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Delay before responding (ms); honours the abort signal. */
  delayMs?: number;
}

export const mockFetch = (
  routes: Record<string, MockRoute | ((init: FetchLikeInit) => MockRoute)>,
): FetchLike & { calls: string[] } => {
  const calls: string[] = [];
  const fn = async (url: string, init: FetchLikeInit) => {
    calls.push(url);
    const r = routes[url];
    const route = typeof r === 'function' ? r(init) : r ?? { status: 404, body: 'not found', headers: { 'content-type': 'text/html' } };
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        init.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }
    const status = route.status ?? 200;
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : route.body ?? '', {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(route.headers ?? {}) },
    });
  };
  return Object.assign(fn, { calls });
};

/** Every hostname resolves to a public address unless listed. */
export const mockResolve = (map: Record<string, string[]> = {}): ResolveAll =>
  async (host) => {
    const list = map[host] ?? ['93.184.216.34'];
    if (!list.length) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
