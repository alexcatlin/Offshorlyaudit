// SSRF guard for fetching stranger-supplied URLs. BUILD_GUIDE §5.2 plus PLAN Phase 2 additions:
// - hex-mapped IPv4-in-IPv6 (WHATWG turns [::ffff:127.0.0.1] into ::ffff:7f00:1)
// - 64:ff9b::/96 (NAT64), 2002::/16 (6to4, embedded v4 checked), 198.18.0.0/15, 192.0.0.0/24, 192.0.2.0/24
// - a connect-time re-check (undici Agent with a custom lookup) to close DNS rebinding.
// Fails closed: anything that isn't a parseable public IP counts as private.
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { BlockedAddressError, SiteReadError } from './errors.js';

// ---------- Address classification ----------

const isPrivateV4 = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 || // "this network", includes 0.0.0.0
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) // 203.0.113.0/24 TEST-NET-3
  );
};

/** Parse an IPv6 literal (optionally with embedded dotted v4 and zone id) into 8 16-bit groups. */
export const parseIPv6 = (input: string): number[] | null => {
  let ip = input.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  // Embedded dotted IPv4 in the last 32 bits.
  const v4 = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const octets = v4[2]!.split('.').map(Number);
    if (octets.some((n) => n > 255)) return null;
    const [o0, o1, o2, o3] = octets as [number, number, number, number];
    ip = `${v4[1]}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
};

const v4FromGroups = (hi: number, lo: number): string =>
  `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

const isPrivateV6 = (ip: string): boolean => {
  const g = parseIPv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::/96 covers ::, ::1 and deprecated IPv4-compatible addresses: check the embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateV4(v4FromGroups(g6, g7));
  // ::ffff:0:0/96 IPv4-mapped (dotted or hex form).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPrivateV4(v4FromGroups(g6, g7));
  // ::ffff:0:0:0/96 IPv4-translated.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64: refuse outright.
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  // 2002::/16 6to4: embedded v4 in groups 1-2.
  if (g0 === 0x2002) return isPrivateV4(v4FromGroups(g1, g2));
  // 2001::/32 Teredo (obfuscated embedded v4) and 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
};

/** True for any private, loopback, link-local, multicast, reserved or unparseable address. */
export const isPrivateAddress = (ip: string): boolean => {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare.split('%')[0] ?? '');
  if (kind === 4) return isPrivateV4(bare);
  if (kind === 6) return isPrivateV6(bare);
  return true;
};

// ---------- URL check ----------

export type ResolveAll = (host: string) => Promise<{ address: string; family: number }[]>;

export const defaultResolveAll: ResolveAll = (host) => dnsLookup(host, { all: true, verbatim: true });

const BLOCKED_HOST_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)\.?$/i;

/**
 * Refuse anything that isn't http(s) on port 80/443 resolving only to public addresses.
 * Returns the resolved addresses. Throws SiteReadError('not_found').
 */
export const assertPublicUrl = async (
  target: URL,
  resolveAll: ResolveAll = defaultResolveAll,
): Promise<{ address: string; family: number }[]> => {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new SiteReadError('not_found', 'Only http and https addresses can be audited.');
  }
  if (target.port && target.port !== '80' && target.port !== '443') {
    throw new SiteReadError('not_found', "That address uses a port that can't be audited.");
  }
  if (target.username || target.password) {
    throw new SiteReadError('not_found', "That address can't be audited.");
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOST_SUFFIX.test(host)) {
    throw new SiteReadError('not_found', "That address can't be audited.");
  }
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolveAll(host);
    } catch {
      throw new SiteReadError('not_found', "We couldn't find a website at that address.");
    }
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new SiteReadError('not_found', "That address can't be audited.");
  }
  return addresses;
};

// ---------- Connect-time guard ----------

/**
 * A `lookup` for net/tls connect that re-resolves and refuses private addresses at connect
 * time, so a DNS answer that changes between assertPublicUrl and the fetch (rebinding) fails.
 */
export const createGuardedLookup = (resolveAll: ResolveAll = defaultResolveAll): LookupFunction =>
  (hostname, options, callback) => {
    const family = typeof options === 'object' && options ? options.family : undefined;
    const wantAll = typeof options === 'object' && options ? options.all === true : false;
    resolveAll(hostname)
      .then((addrs) => {
        if (!addrs.length) {
          const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
          throw err;
        }
        if (addrs.some((a) => isPrivateAddress(a.address))) throw new BlockedAddressError(hostname);
        const fam = family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family;
        const list: LookupAddress[] = (fam === 4 || fam === 6 ? addrs.filter((a) => a.family === fam) : addrs).map(
          (a) => ({ address: a.address, family: a.family }),
        );
        if (!list.length) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
        }
        if (wantAll) callback(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, '', 0));
  };

/** undici Agent whose every connection goes through the guarded lookup. */
export const createSafeAgent = (resolveAll: ResolveAll = defaultResolveAll, connectTimeoutMs = 10_000): Agent =>
  new Agent({
    connect: { lookup: createGuardedLookup(resolveAll), timeout: connectTimeoutMs },
    connections: 8,
  });
