import { describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { assertPublicUrl, createGuardedLookup, createSafeAgent, isPrivateAddress, parseIPv6 } from '../../server/site/ssrf.js';
import { SiteReadError, findCause, isBlockedAddressError } from '../../server/site/errors.js';
import { mockResolve } from './_siteMock.js';

describe('isPrivateAddress', () => {
  const privateIps = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%lo0',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::808:808',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '2001:db8::1',
    '[::1]',
    'not-an-ip',
    '',
  ];
  it.each(privateIps)('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '198.20.0.1', '2606:4700::', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1', '2a00:1450:4009:81f::200e'];
  it.each(publicIps)('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('parses hex-mapped and dotted-mapped forms to the same groups', () => {
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual(parseIPv6('::ffff:7f00:1'));
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
  });

  it('WHATWG URL normalisation of [::ffff:127.0.0.1] is still caught', () => {
    const host = new URL('http://[::ffff:127.0.0.1]/').hostname;
    expect(host).toBe('[::ffff:7f00:1]');
    expect(isPrivateAddress(host)).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const resolve = mockResolve({ 'evil.test': ['127.0.0.1'], 'mixed.test': ['93.184.216.34', '10.0.0.5'], 'gone.test': [] });
  const refuse = async (url: string) => {
    const err = await assertPublicUrl(new URL(url), resolve).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteReadError);
    expect((err as SiteReadError).code).toBe('not_found');
  };

  it('rejects ftp', () => refuse('ftp://example.com/'));
  it('rejects port 8080', () => refuse('http://example.com:8080/'));
  it('rejects a hostname resolving to 127.0.0.1', () => refuse('http://evil.test/'));
  it('rejects when any resolved address is private', () => refuse('http://mixed.test/'));
  it('rejects unresolvable hosts', () => refuse('http://gone.test/'));
  it('rejects decimal IPv4 (2130706433 → 127.0.0.1)', () => refuse('http://2130706433/'));
  it('rejects localhost without DNS', () => refuse('http://localhost:80/'));
  it('rejects IPv6 loopback and mapped literals', async () => {
    await refuse('http://[::1]/');
    await refuse('http://[::ffff:127.0.0.1]/');
  });
  it('rejects credentials in the URL', () => refuse('https://user:pass@example.com/'));
  it('accepts a public host on 443', async () => {
    await expect(assertPublicUrl(new URL('https://example.com:443/'), resolve)).resolves.toHaveLength(1);
  });
});

describe('connect-time guard', () => {
  it('guarded lookup refuses private answers', async () => {
    const lookup = createGuardedLookup(mockResolve({ 'rebind.test': ['127.0.0.1'] }));
    const err = await new Promise<unknown>((resolve) => lookup('rebind.test', { all: true }, (e) => resolve(e)));
    expect(isBlockedAddressError(err)).toBe(true);
  });

  it('guarded lookup returns public answers in both callback forms', async () => {
    const lookup = createGuardedLookup(mockResolve({ 'ok.test': ['93.184.216.34'] }));
    const all = await new Promise<unknown>((resolve) => lookup('ok.test', { all: true }, (_e, a) => resolve(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const one = await new Promise<unknown[]>((resolve) => lookup('ok.test', {}, (_e, a, f) => resolve([a, f])));
    expect(one).toEqual(['93.184.216.34', 4]);
  });

  it('undici Agent uses the guard (DNS rebinding closed at connect time)', async () => {
    // The resolver says 127.0.0.1 at connect time: the request must fail with our error before connecting.
    const agent = createSafeAgent(mockResolve({ 'rebind.test': ['127.0.0.1'] }));
    const err = await undiciFetch('http://rebind.test/', { dispatcher: agent }).catch((e: unknown) => e);
    expect(findCause(err, isBlockedAddressError)).not.toBeNull();
    await agent.close();
  });
});
