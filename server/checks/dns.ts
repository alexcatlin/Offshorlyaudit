// SPF and DMARC from public DNS. Look up the host and each parent domain, stopping before
// compound suffixes (co.uk etc.) and bare TLDs. 4 s timeout per lookup.
import { resolveTxt as nodeResolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CheckResult } from '../../shared/types.js';

export type ResolveTxt = (name: string) => Promise<string[][]>;

export const COMPOUND_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'co.nz',
  'co.jp',
  'com.br',
]);

export const DNS_TIMEOUT_MS = 4_000;

/** Host, then each parent, stopping before a compound suffix or a single-label TLD. */
export const domainCandidates = (host: string): string[] => {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    if (COMPOUND_SUFFIXES.has(name)) break;
    out.push(name);
  }
  return out;
};

type TxtOutcome = { records: string[] } | { error: true };

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const lookupTxt = async (name: string, resolveTxt: ResolveTxt, timeoutMs: number): Promise<TxtOutcome> => {
  try {
    const rows = await withTimeout(resolveTxt(name), timeoutMs);
    return { records: rows.map((chunks) => chunks.join('')) };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? '';
    return NOT_FOUND.has(code) ? { records: [] } : { error: true };
  }
};

export interface EmailDnsDeps {
  resolveTxt?: ResolveTxt;
  timeoutMs?: number;
}

export const checkSpf = async (host: string, deps: EmailDnsDeps = {}): Promise<CheckResult> => {
  const resolveTxt = deps.resolveTxt ?? nodeResolveTxt;
  const timeoutMs = deps.timeoutMs ?? DNS_TIMEOUT_MS;
  const names = domainCandidates(host);
  let errors = 0;
  for (const name of names) {
    const r = await lookupTxt(name, resolveTxt, timeoutMs);
    if ('error' in r) {
      errors++;
      continue;
    }
    if (r.records.some((t) => /^v=spf1(\s|$)/i.test(t.trim()))) {
      return { id: 'sec-spf', status: 'pass', detail: `SPF record found on ${name}.` };
    }
  }
  if (names.length && errors === names.length) {
    return { id: 'sec-spf', status: 'info', detail: "We couldn't check DNS for an SPF record." };
  }
  return { id: 'sec-spf', status: 'fail', detail: `No SPF record found on ${names[names.length - 1] ?? host}.` };
};

export const checkDmarc = async (host: string, deps: EmailDnsDeps = {}): Promise<CheckResult> => {
  const resolveTxt = deps.resolveTxt ?? nodeResolveTxt;
  const timeoutMs = deps.timeoutMs ?? DNS_TIMEOUT_MS;
  const names = domainCandidates(host);
  let errors = 0;
  for (const name of names) {
    const r = await lookupTxt(`_dmarc.${name}`, resolveTxt, timeoutMs);
    if ('error' in r) {
      errors++;
      continue;
    }
    const rec = r.records.find((t) => /^v=dmarc1\s*(;|$)/i.test(t.trim()));
    if (!rec) continue;
    const p = rec.match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i)?.[1]?.toLowerCase();
    if (p === 'quarantine' || p === 'reject') {
      return { id: 'sec-dmarc', status: 'pass', detail: `DMARC policy on ${name} is p=${p}.` };
    }
    if (p === 'none') {
      return { id: 'sec-dmarc', status: 'warn', detail: `DMARC on ${name} is p=none: it monitors but does not block forged email.` };
    }
    return { id: 'sec-dmarc', status: 'warn', detail: `DMARC record on ${name} has no valid policy (p=).` };
  }
  if (names.length && errors === names.length) {
    return { id: 'sec-dmarc', status: 'info', detail: "We couldn't check DNS for a DMARC record." };
  }
  return { id: 'sec-dmarc', status: 'fail', detail: `No DMARC record found on ${names[names.length - 1] ?? host}.` };
};

/** sec-spf and sec-dmarc. A site addressed by IP gets two `info` results. */
export const emailChecks = async (host: string, deps: EmailDnsDeps = {}): Promise<CheckResult[]> => {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) || domainCandidates(bare).length === 0) {
    return [
      { id: 'sec-spf', status: 'info', detail: 'Not applicable: the site has no domain name.' },
      { id: 'sec-dmarc', status: 'info', detail: 'Not applicable: the site has no domain name.' },
    ];
  }
  return Promise.all([checkSpf(bare, deps), checkDmarc(bare, deps)]);
};
