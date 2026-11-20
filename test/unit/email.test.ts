import { describe, expect, it } from 'vitest';
import { isDisposableDomain } from '../../server/lead/disposable.js';
import {
  canonicalEmail,
  createEmailChecker,
  domainAcceptsMail,
  emailKey,
  isAllowlisted,
  parseAllowlist,
} from '../../server/lead/email.js';
import type { MxResolver } from '../../server/lead/email.js';
import { isFreemailDomain } from '../../server/lead/freemail.js';
import { fakeMx } from './_appMock.js';

const err = (code: string) => Object.assign(new Error(code), { code });
const never = () => new Promise<never>(() => undefined);

describe('canonicalEmail', () => {
  it('lowercases, trims, strips +tags everywhere and Gmail dots', () => {
    expect(canonicalEmail('  Jo.Bloggs+Audit@Example.COM ')).toBe('jo.bloggs@example.com');
    expect(canonicalEmail('j.o.bloggs+x@gmail.com')).toBe('jobloggs@gmail.com');
    expect(canonicalEmail('J.O.Bloggs@GoogleMail.com')).toBe('jobloggs@gmail.com');
    // Dots only matter for Gmail.
    expect(canonicalEmail('j.o@outlook.com')).toBe('j.o@outlook.com');
    // A leading "+" is part of the local part, not a tag.
    expect(canonicalEmail('+x@example.com')).toBe('+x@example.com');
  });
});

describe('emailKey', () => {
  it('is a stable 32-hex HMAC per secret, different across secrets, on the canonical form', () => {
    const a = emailKey('secret-one-0123456789', 'jo+x@Example.com');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(emailKey('secret-one-0123456789', 'jo@example.com')).toBe(a);
    expect(emailKey('secret-two-0123456789', 'jo@example.com')).not.toBe(a);
    expect(emailKey('secret-one-0123456789', 'jo2@example.com')).not.toBe(a);
  });
});

describe('domainAcceptsMail', () => {
  it('MX ok; A-only ok; NXDOMAIN and no records rejected', async () => {
    expect(await domainAcceptsMail('acme.example', fakeMx)).toBe(true);
    expect(await domainAcceptsMail('a-only.example', fakeMx)).toBe(true);
    expect(await domainAcceptsMail('nxdomain.example', fakeMx)).toBe(false);
    expect(await domainAcceptsMail('nomail.example', fakeMx)).toBe(false);
  });

  it('fails open on timeout and SERVFAIL; rejects a null MX', async () => {
    const slow: MxResolver = { resolveMx: never, resolve4: never, resolve6: never };
    expect(await domainAcceptsMail('slow.example', slow, 20)).toBe(true);
    const servfail: MxResolver = {
      resolveMx: async () => {
        throw err('ESERVFAIL');
      },
      resolve4: async () => [],
      resolve6: async () => [],
    };
    expect(await domainAcceptsMail('x.example', servfail)).toBe(true);
    const aServfail: MxResolver = {
      resolveMx: async () => {
        throw err('ENODATA');
      },
      resolve4: async () => {
        throw err('ESERVFAIL');
      },
      resolve6: async () => {
        throw err('ENODATA');
      },
    };
    expect(await domainAcceptsMail('x.example', aServfail)).toBe(true);
    const nullMx: MxResolver = { resolveMx: async () => [{ exchange: '', priority: 0 }], resolve4: async () => [], resolve6: async () => [] };
    expect(await domainAcceptsMail('x.example', nullMx)).toBe(false);
  });
});

describe('createEmailChecker', () => {
  it('rejects syntax, length, disposable and undeliverable; caches the MX verdict', async () => {
    let lookups = 0;
    const counting: MxResolver = {
      ...fakeMx,
      resolveMx: async (d) => {
        lookups++;
        return fakeMx.resolveMx(d);
      },
    };
    const c = createEmailChecker({ resolver: counting });
    expect(await c.check('jo@acme.example')).toBe('ok');
    expect(await c.check('jo2@acme.example')).toBe('ok');
    expect(lookups).toBe(1);
    expect(await c.check('no-at-sign')).toBe('syntax');
    expect(await c.check('jo@localhost')).toBe('syntax');
    expect(await c.check('a b@acme.example')).toBe('syntax');
    expect(await c.check(`${'x'.repeat(65)}@acme.example`)).toBe('syntax');
    expect(await c.check(`jo@${'a'.repeat(250)}.example`)).toBe('syntax');
    expect(await c.check('jo@mailinator.com')).toBe('disposable');
    expect(await c.check('jo@nxdomain.example')).toBe('undeliverable');
  });

  it('local part must be printable ASCII: NUL, ESC, DEL and zero-width variants are syntax errors', async () => {
    const c = createEmailChecker({ resolver: fakeMx });
    for (const bad of ['jo\u0000@acme.example', 'jo\u001b@acme.example', 'jo\u007f@acme.example', 'jo\u200b@acme.example', '\u200djo@acme.example', 'jo\ufeff@acme.example', 'jö@acme.example']) {
      expect(await c.check(bad), JSON.stringify(bad)).toBe('syntax');
    }
    expect(await c.check("o'brien.jo+tag@acme.example")).toBe('ok');
  });
});

describe('static lists', () => {
  it('disposable list matches listed domains and their subdomains', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('x.mailinator.com')).toBe(true);
    expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    expect(isDisposableDomain('notmailinator.com')).toBe(false);
    expect(isDisposableDomain('gmail.com')).toBe(false);
  });

  it('free-mail list', () => {
    expect(isFreemailDomain('gmail.com')).toBe(true);
    expect(isFreemailDomain('Outlook.com')).toBe(true);
    expect(isFreemailDomain('acme.example')).toBe(false);
  });
});

describe('allow-list', () => {
  it('@domain matches that exact domain, not subdomains; exact entries match canonically', () => {
    const r = parseAllowlist(['@offshorly.com', 'Tester+x@Example.org', 'j.o@gmail.com']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = r.value;
    expect(isAllowlisted(list, 'a@offshorly.com')).toBe(true);
    expect(isAllowlisted(list, 'A+tag@Offshorly.com')).toBe(true);
    expect(isAllowlisted(list, 'a@x.offshorly.com')).toBe(false);
    expect(isAllowlisted(list, 'tester@example.org')).toBe(true);
    expect(isAllowlisted(list, 'tester+other@example.org')).toBe(true);
    expect(isAllowlisted(list, 'other@example.org')).toBe(false);
    expect(isAllowlisted(list, 'jo@googlemail.com')).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(parseAllowlist(['@'])).toMatchObject({ ok: false });
    expect(parseAllowlist(['not an email'])).toMatchObject({ ok: false });
    expect(parseAllowlist(['@nodot'])).toMatchObject({ ok: false });
  });
});
