// Security basics from the homepage response, BUILD_GUIDE §5.7 (sec-permissions dropped).
// SPF/DMARC live in dns.ts. Details are factual, server-written.
import type { CheckResult } from '../../shared/types.js';
import { findTags, stripComments } from '../site/html.js';

export interface SecurityInput {
  home: { finalUrl: string; headers: Record<string, string>; setCookies: string[]; html: string };
  /** Result of following http://host/; null if it couldn't be fetched. */
  httpProbe: { finalUrl: string } | null;
}

/** Echo a site-supplied header value safely: printable token characters only, clipped. */
const clip = (s: string, n = 60): string => {
  const t = s.replace(/[^A-Za-z0-9 ._/()'=;:,+*-]/g, '').replace(/\s+/g, ' ').trim();
  if (/vulnerab|insecure/i.test(t)) return '(value not shown)';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const checkHttps = (finalUrl: string): CheckResult =>
  finalUrl.startsWith('https:')
    ? { id: 'sec-https', status: 'pass', detail: 'The homepage loads over HTTPS.' }
    : { id: 'sec-https', status: 'fail', detail: 'The homepage loads over plain HTTP, without encryption.' };

export const checkRedirect = (probe: { finalUrl: string } | null): CheckResult => {
  if (!probe) return { id: 'sec-redirect', status: 'info', detail: "We couldn't load the http:// address to test it." };
  return probe.finalUrl.startsWith('https:')
    ? { id: 'sec-redirect', status: 'pass', detail: 'The http:// address redirects to HTTPS.' }
    : { id: 'sec-redirect', status: 'fail', detail: 'The http:// address stays on plain HTTP.' };
};

export const checkHsts = (headers: Record<string, string>, https: boolean): CheckResult => {
  const v = headers['strict-transport-security'];
  if (!https) return { id: 'sec-hsts', status: 'fail', detail: 'The site is not served over HTTPS, so HSTS cannot apply.' };
  if (!v) return { id: 'sec-hsts', status: 'fail', detail: 'No Strict-Transport-Security header.' };
  const maxAge = Number(v.match(/max-age\s*=\s*"?(\d+)/i)?.[1] ?? NaN);
  if (maxAge === 0) return { id: 'sec-hsts', status: 'fail', detail: 'Strict-Transport-Security is set with max-age=0, which turns it off.' };
  return { id: 'sec-hsts', status: 'pass', detail: 'Strict-Transport-Security header is set.' };
};

export const checkCsp = (headers: Record<string, string>): CheckResult =>
  headers['content-security-policy']
    ? { id: 'sec-csp', status: 'pass', detail: 'Content-Security-Policy header is set.' }
    : {
        id: 'sec-csp',
        status: 'fail',
        detail: headers['content-security-policy-report-only']
          ? 'Only a report-only Content-Security-Policy is set, which does not block anything.'
          : 'No Content-Security-Policy header.',
      };

export const checkFrame = (headers: Record<string, string>): CheckResult => {
  const xfo = headers['x-frame-options'];
  const csp = headers['content-security-policy'] ?? '';
  if (/frame-ancestors/i.test(csp)) return { id: 'sec-frame', status: 'pass', detail: 'Content-Security-Policy sets frame-ancestors.' };
  if (xfo && /deny|sameorigin/i.test(xfo)) return { id: 'sec-frame', status: 'pass', detail: `X-Frame-Options is ${clip(xfo.toUpperCase(), 30)}.` };
  if (xfo) return { id: 'sec-frame', status: 'warn', detail: `X-Frame-Options has an unsupported value (${clip(xfo, 30)}).` };
  return { id: 'sec-frame', status: 'fail', detail: 'No X-Frame-Options header or frame-ancestors rule.' };
};

export const checkNosniff = (headers: Record<string, string>): CheckResult =>
  /nosniff/i.test(headers['x-content-type-options'] ?? '')
    ? { id: 'sec-nosniff', status: 'pass', detail: 'X-Content-Type-Options is nosniff.' }
    : { id: 'sec-nosniff', status: 'fail', detail: 'No X-Content-Type-Options: nosniff header.' };

export const checkReferrer = (headers: Record<string, string>, html: string): CheckResult => {
  const h = headers['referrer-policy'];
  if (h) return { id: 'sec-referrer', status: 'pass', detail: `Referrer-Policy is ${clip(h, 40)}.` };
  const meta = findTags(html, 'meta').find((a) => (a.name ?? '').toLowerCase() === 'referrer' && a.content);
  if (meta) return { id: 'sec-referrer', status: 'pass', detail: `A referrer policy (${clip(meta.content!, 40)}) is set in the page.` };
  return { id: 'sec-referrer', status: 'warn', detail: 'No Referrer-Policy header.' };
};

export const checkCookies = (setCookies: string[]): CheckResult => {
  if (!setCookies.length) return { id: 'sec-cookies', status: 'pass', detail: 'The homepage sets no cookies.' };
  const weak = setCookies.filter((c) => !/;\s*secure\b/i.test(c) || !/;\s*samesite\s*=/i.test(c));
  if (!weak.length) {
    return { id: 'sec-cookies', status: 'pass', detail: `All ${setCookies.length} cookie(s) set by the homepage are Secure and SameSite.` };
  }
  return {
    id: 'sec-cookies',
    status: 'warn',
    detail: `${weak.length} of ${setCookies.length} cookie(s) set by the homepage lack the Secure or SameSite flag.`,
  };
};

export const checkDisclosure = (headers: Record<string, string>): CheckResult => {
  const shown: string[] = [];
  for (const name of ['server', 'x-powered-by']) {
    const v = headers[name];
    if (v && /\d/.test(v)) shown.push(`${name === 'server' ? 'Server' : 'X-Powered-By'}: ${clip(v, 40)}`);
  }
  return shown.length
    ? { id: 'sec-disclosure', status: 'warn', detail: `Response headers show software versions (${shown.join('; ')}).` }
    : { id: 'sec-disclosure', status: 'pass', detail: 'Response headers do not show software version numbers.' };
};

const MIXED_TAGS: readonly [string, string][] = [
  ['script', 'src'],
  ['img', 'src'],
  ['iframe', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
  ['embed', 'src'],
];

export const findMixedContent = (html: string): string[] => {
  const clean = stripComments(html);
  const found: string[] = [];
  for (const [tag, attr] of MIXED_TAGS) {
    for (const a of findTags(clean, tag)) {
      const v = (a[attr] ?? '').trim();
      if (/^http:\/\//i.test(v)) found.push(v);
      if (tag === 'img' || tag === 'source') {
        const srcset = a.srcset ?? '';
        if (/(^|,)\s*http:\/\//i.test(srcset)) found.push(srcset);
      }
    }
  }
  for (const a of findTags(clean, 'link')) {
    if (/\bstylesheet\b/i.test(a.rel ?? '') && /^http:\/\//i.test((a.href ?? '').trim())) found.push(a.href!);
  }
  return found;
};

export const checkMixed = (html: string, https: boolean): CheckResult => {
  if (!https) return { id: 'sec-mixed', status: 'info', detail: 'Not applicable: the page itself is not served over HTTPS.' };
  const found = findMixedContent(html);
  return found.length
    ? { id: 'sec-mixed', status: 'fail', detail: `${found.length} image(s), script(s) or file(s) on the homepage load over plain http://.` }
    : { id: 'sec-mixed', status: 'pass', detail: 'Everything on the homepage loads over HTTPS.' };
};

/** sec-https … sec-mixed (not sec-spf / sec-dmarc). */
export const securityChecks = (input: SecurityInput): CheckResult[] => {
  const { home, httpProbe } = input;
  const https = home.finalUrl.startsWith('https:');
  return [
    checkHttps(home.finalUrl),
    checkRedirect(httpProbe),
    checkHsts(home.headers, https),
    checkCsp(home.headers),
    checkFrame(home.headers),
    checkNosniff(home.headers),
    checkReferrer(home.headers, home.html),
    checkCookies(home.setCookies),
    checkDisclosure(home.headers),
    checkMixed(home.html, https),
  ];
};
