// HTTP hardening helpers: origin allow-list, security headers/CSP, hashed client IPs.
import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError } from '../../shared/types.js';
import { parseIPv6 } from '../site/ssrf.js';

export interface OriginPolicy {
  publicOrigin: string | null;
  allowedOrigins: readonly string[];
}

/**
 * Same-origin calls and listed origins only.
 * - Origin present: must be PUBLIC_ORIGIN, the request's own host, or in ALLOWED_ORIGINS.
 * - Origin absent: allowed only for GET when the browser does not say the call is cross-site
 *   (Chrome omits Origin on same-origin GETs). POSTs from browsers always carry Origin.
 */
export const originAllowed = (req: FastifyRequest, policy: OriginPolicy): boolean => {
  const origin = req.headers.origin;
  if (!origin) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (policy.publicOrigin && parsed.origin === policy.publicOrigin) return true;
  if (policy.allowedOrigins.includes(parsed.origin)) return true;
  // The raw Host header, never req.host: with trustProxy on, req.host follows
  // X-Forwarded-Host, which the caller controls.
  const host = req.headers.host;
  return typeof host === 'string' && !!host && parsed.host.toLowerCase() === host.toLowerCase();
};

export interface HeaderPolicy {
  frameAncestors: readonly string[];
  typekit: boolean;
  hsts: boolean;
}

const TYPEKIT_HOSTS = 'https://use.typekit.net https://p.typekit.net';

/** Content-Security-Policy for the widget. frame-ancestors replaces X-Frame-Options. */
export const buildCsp = (p: HeaderPolicy): string => {
  const tk = p.typekit ? ` ${TYPEKIT_HOSTS}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self'${tk}`,
    `font-src 'self' data:${tk}`,
    `img-src 'self' data:${tk}`,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors 'self'${p.frameAncestors.length ? ` ${p.frameAncestors.join(' ')}` : ''}`,
  ].join('; ');
};

export const securityHeaders = (p: HeaderPolicy): Record<string, string> => ({
  'content-security-policy': buildCsp(p),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  // No Cross-Origin-Resource-Policy: embed.js must load from the host site. No X-Frame-Options:
  // frame-ancestors above governs embedding.
  ...(p.hsts ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
});

/**
 * The address a rate limit should count against. IPv4 as is; IPv4-mapped IPv6
 * (::ffff:a.b.c.d) as the IPv4 address; other IPv6 bucketed to its /64, because one host
 * usually controls a whole /64 and could otherwise rotate through unlimited keys.
 */
export const rateLimitSubject = (ip: string | undefined): string => {
  if (!ip) return 'unknown';
  if (isIPv4(ip)) return ip;
  const g = parseIPv6(ip);
  if (!g || g.length !== 8) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6]!, g[7]!];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
};

/** Salted (per process) hash so logs and limiter keys never hold a raw IP. */
export const createIpHasher = (salt: string = randomBytes(16).toString('hex')) => (ip: string | undefined): string =>
  createHash('sha256')
    .update(`${salt}|${ip ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 16);

export const sendError = (reply: FastifyReply, status: number, body: ApiError): FastifyReply => {
  if (body.retryAfterSec !== undefined) reply.header('retry-after', String(body.retryAfterSec));
  return reply.code(status).send(body);
};
