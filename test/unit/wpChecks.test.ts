import { describe, expect, it } from 'vitest';
import type { CheckResult, WordPressInfo, WpComponent } from '../../shared/types.js';
import { coreCheck, displayName, pluginsCheck, themeCheck, versionExposedCheck, wordpressChecks, xmlrpcCheck } from '../../server/cms/wpChecks.js';
import { isStale } from '../../server/cms/wordpress.js';

const comp = (o: Partial<WpComponent> & Pick<WpComponent, 'slug'>): WpComponent => ({
  type: 'plugin',
  name: null,
  version: null,
  versionSource: null,
  latest: null,
  directory: 'listed',
  stale: false,
  status: 'unknown',
  ...o,
});

const wp = (o: Partial<WordPressInfo> = {}, core: Partial<WordPressInfo['core']> = {}): WordPressInfo => ({
  core: { version: '6.4.2', source: 'generator', latest: '7.1.5', status: 'outdated', ...core },
  components: [],
  xmlrpcAdvertised: false,
  versionExposed: false,
  vulnSource: null,
  ...o,
});

describe('wp-core-version', () => {
  it('insecure → fail, and only this status says "insecure"', () => {
    const r = coreCheck(wp({}, { version: '6.1.1', status: 'insecure' }));
    expect(r.status).toBe('fail');
    expect(r.detail).toBe("Running 6.1.1 (seen in the page's generator tag), which WordPress.org lists as insecure; latest is 7.1.5.");
  });
  it('outdated → warn', () => {
    expect(coreCheck(wp())).toEqual({
      id: 'wp-core-version',
      status: 'warn',
      detail: "Running 6.4.2 (seen in the page's generator tag); latest is 7.1.5. Updates often include security fixes.",
    });
  });
  it('latest → pass', () => expect(coreCheck(wp({}, { version: '7.1.5', status: 'latest' })).status).toBe('pass'));
  it('no version → info "Version not shown publicly"', () => {
    expect(coreCheck(wp({}, { version: null, source: null, status: 'unknown' }))).toMatchObject({ status: 'info', detail: 'Version not shown publicly.' });
  });
  it('version but unknown status → info', () => expect(coreCheck(wp({}, { status: 'unknown', source: 'asset' })).status).toBe('info'));
});

describe('wp-plugins / wp-theme', () => {
  it('fix_available → fail', () => {
    const r = pluginsCheck(wp({ components: [comp({ slug: 'a', name: 'Alpha', version: '1.0', latest: '1.2', status: 'fix_available' }), comp({ slug: 'b', status: 'up_to_date', version: '2.0', latest: '2.0' })] }));
    expect(r.status).toBe('fail');
    expect(r.detail).toBe('1 of 2 detected plugins: security fix available for Alpha (running 1.0, latest 1.2).');
  });
  it('closed → fail, "closed" only, never a closure reason', () => {
    const r = pluginsCheck(wp({ components: [comp({ slug: 'display-widgets', name: 'Display Widgets', directory: 'closed' })] }));
    expect(r).toMatchObject({ status: 'fail', detail: 'No longer available in the WordPress.org directory (closed): Display Widgets.' });
    expect(r.detail).not.toMatch(/reason|security issue/i);
  });
  it('outdated → warn with the "3 of 7" style', () => {
    const items = [
      ...['a', 'b', 'c'].map((s) => comp({ slug: s, version: '1.0', latest: '2.0', status: 'outdated' })),
      ...['d', 'e', 'f', 'g'].map((s) => comp({ slug: s, version: '1.0', latest: '1.0', status: 'up_to_date' })),
    ];
    const r = pluginsCheck(wp({ components: items }));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/^3 of 7 detected plugins are behind the latest version: a \(running 1\.0, latest 2\.0\)/);
  });
  it('stale → warn', () => {
    const r = pluginsCheck(wp({ components: [comp({ slug: 'old', name: 'Old Plugin', stale: true, status: 'up_to_date', version: '1.0', latest: '1.0' })] }));
    expect(r).toMatchObject({ status: 'warn' });
    expect(r.detail).toMatch(/Old Plugin has had no update in the WordPress.org directory for over two years/);
  });
  it('all known up to date → pass; partial versions say so', () => {
    expect(pluginsCheck(wp({ components: [comp({ slug: 'a', status: 'up_to_date', version: '1', latest: '1' })] })).status).toBe('pass');
    const r = pluginsCheck(wp({ components: [comp({ slug: 'a', status: 'up_to_date', version: '1.0' }), comp({ slug: 'b' })] }));
    expect(r).toMatchObject({ status: 'pass', detail: expect.stringMatching(/^1 of 2 detected plugins show a version/) });
  });
  it('no data → info', () => {
    expect(pluginsCheck(wp()).status).toBe('info');
    expect(pluginsCheck(wp({ components: [comp({ slug: 'a' })] })).status).toBe('info');
  });
  it('custom theme not listed → info', () => {
    const r = themeCheck(wp({ components: [comp({ type: 'theme', slug: 'offshorly-v2', directory: 'not_listed', version: '2.0', versionSource: 'stylesheet' })] }));
    expect(r).toMatchObject({ status: 'info', detail: expect.stringMatching(/^offshorly-v2 2\.0 is a custom or premium theme, not in the WordPress\.org directory/) });
  });
  it('theme outdated → warn', () => {
    const r = themeCheck(wp({ components: [comp({ type: 'theme', slug: 'astra', name: 'Astra', version: '4.5.2', latest: '4.8.0', status: 'outdated' })] }));
    expect(r).toMatchObject({ status: 'warn', detail: 'Astra is behind the latest version (running 4.5.2, latest 4.8.0). Updates often include security fixes.' });
  });
});

describe('wp-xmlrpc / wp-version-exposed', () => {
  it('maps flags', () => {
    expect(xmlrpcCheck(wp({ xmlrpcAdvertised: true })).status).toBe('warn');
    expect(xmlrpcCheck(wp()).status).toBe('pass');
    expect(versionExposedCheck(wp({ versionExposed: true }))).toMatchObject({ status: 'warn', detail: "The WordPress version (6.4.2) is shown in the page's generator tag." });
    expect(versionExposedCheck(wp()).status).toBe('pass');
  });
});

describe('wording rules', () => {
  const statuses: WpComponent['status'][] = ['up_to_date', 'outdated', 'fix_available', 'unknown'];
  const dirs: WpComponent['directory'][] = ['listed', 'closed', 'not_listed', 'unknown'];
  const coreStatuses: WordPressInfo['core']['status'][] = ['latest', 'outdated', 'insecure', 'unknown'];

  const all: { core: WordPressInfo['core']['status']; checks: CheckResult[] }[] = [];
  for (const cs of coreStatuses)
    for (const s of statuses)
      for (const d of dirs)
        for (const stale of [true, false])
          all.push({
            core: cs,
            checks: wordpressChecks(
              wp(
                {
                  components: [
                    comp({ slug: 'p', status: s, directory: d, stale, version: '1.0', latest: '2.0' }),
                    comp({ type: 'theme', slug: 't', status: s, directory: d, stale, version: '1.0', latest: '2.0' }),
                  ],
                  xmlrpcAdvertised: true,
                  versionExposed: true,
                },
                { status: cs },
              ),
            ),
          });

  it('never contains "vulnerable"', () => {
    for (const { checks } of all) for (const c of checks) expect(c.detail).not.toMatch(/vulnerab/i);
  });
  it('"insecure" appears only for the stable-check insecure status, only in wp-core-version', () => {
    for (const { core, checks } of all) {
      for (const c of checks) {
        if (/insecure/i.test(c.detail)) {
          expect(c.id).toBe('wp-core-version');
          expect(core).toBe('insecure');
        }
      }
    }
  });
  it('no CVE ids or links in any detail', () => {
    for (const { checks } of all) for (const c of checks) expect(c.detail).not.toMatch(/CVE-|https?:\/\//i);
  });
  it('names containing banned words or HTML fall back to the slug', () => {
    expect(displayName({ type: 'plugin', slug: 'safe-slug', name: 'Totally Vulnerable Plugin' })).toBe('safe-slug');
    expect(displayName({ type: 'plugin', slug: 'insecure-thing', name: null })).toBe('a plugin');
    expect(displayName({ type: 'theme', slug: 't', name: '<b>Nice</b> Theme' })).toBe('Nice Theme');
    expect(displayName({ type: 'plugin', slug: 'jetpack', name: 'Jetpack – AI Agents & MCP, Security, Backup & Speed Tools' })).toBe('Jetpack');
    expect(displayName({ type: 'plugin', slug: 'x', name: 'A very long plugin name without any dash separator at all here ok' })).toBe('A very long plugin name without any dash…');
  });
  it('fix_available wording only when Wordfence status is set', () => {
    for (const { checks } of all) {
      const p = checks.find((c) => c.id === 'wp-plugins')!;
      if (/security fix available/.test(p.detail)) expect(p.status).toBe('fail');
    }
  });
});

describe('stale', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  it('over 24 months ago', () => {
    expect(isStale('2024-11-19', now)).toBe(true);
    expect(isStale('2024-11-21', now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
  });
});
