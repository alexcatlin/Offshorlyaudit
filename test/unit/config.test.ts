import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_FRAME_ANCESTORS, DEV_ORIGINS, loadConfig, loadLocalEnv } from '../../server/config.js';

describe('loadConfig', () => {
  it('refuses to start in production with fixture AI', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AI_MODE: 'fixture' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', AI_MODE: 'fixture' })).toThrow(/not allowed in production/);
  });

  it('defaults AI mode: live with a key, else fixture in dev and off in production', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k' }).aiMode).toBe('live');
    expect(loadConfig({}).aiMode).toBe('fixture');
    expect(loadConfig({ ANTHROPIC_API_KEY: '  ' }).aiMode).toBe('fixture');
    expect(loadConfig({ NODE_ENV: 'production' }).aiMode).toBe('off');
    expect(loadConfig({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' }).aiMode).toBe('live');
  });

  it('rejects live without a key and unknown modes', () => {
    expect(() => loadConfig({ AI_MODE: 'live' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ AI_MODE: 'maybe' })).toThrow(ConfigError);
  });

  it('applies the planned defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      rateLimitHourly: 5,
      rateLimitDaily: 20,
      dailyAiAudits: 50,
      maxConcurrentAudits: 4,
      cacheTtlMin: 360,
      trustProxyHops: 1,
      port: 8787,
      typekitKitUrl: null,
      emailGate: 'on',
      emailHashSecretGenerated: true,
      ledgerPath: null,
      ledgerRetentionDays: 365,
      crmSyncAllowlisted: false,
      twentyApiUrl: null,
      twentyApiKey: null,
      allowedFrameAncestors: DEFAULT_FRAME_ANCESTORS,
      allowedOrigins: DEV_ORIGINS,
    });
    expect(loadConfig({ NODE_ENV: 'production' }).allowedOrigins).toEqual([]);
  });

  it('validates numbers, origins, frame ancestors and URLs', () => {
    expect(() => loadConfig({ RATE_LIMIT_HOURLY: 'five' })).toThrow(/whole number/);
    expect(() => loadConfig({ MAX_CONCURRENT_AUDITS: '0' })).toThrow(/between/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://audit.example/path' })).toThrow(/no path/);
    expect(loadConfig({ PUBLIC_ORIGIN: 'https://Audit.Example' }).publicOrigin).toBe('https://audit.example');
    expect(() => loadConfig({ ALLOWED_FRAME_ANCESTORS: "https://a.example; script-src 'unsafe-inline'" })).toThrow(ConfigError);
    expect(loadConfig({ ALLOWED_FRAME_ANCESTORS: 'https://a.example https://*.b.example' }).allowedFrameAncestors).toEqual([
      'https://a.example',
      'https://*.b.example',
    ]);
    expect(() => loadConfig({ TYPEKIT_KIT_URL: 'https://evil.example/x.css' })).toThrow(/typekit/);
    expect(loadConfig({ TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
  });
});

describe('Amendment 3 variables', () => {
  it('EMAIL_GATE is on or off', () => {
    expect(loadConfig({ EMAIL_GATE: 'OFF' }).emailGate).toBe('off');
    expect(() => loadConfig({ EMAIL_GATE: 'maybe' })).toThrow(/EMAIL_GATE/);
  });

  it('EMAIL_HASH_SECRET: random per process when unset, used as given otherwise', () => {
    const a = loadConfig({});
    const b = loadConfig({});
    expect(a.emailHashSecret).not.toBe(b.emailHashSecret);
    expect(a.emailHashSecret.length).toBeGreaterThanOrEqual(32);
    const c = loadConfig({ EMAIL_HASH_SECRET: 'B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk=' });
    expect(c).toMatchObject({ emailHashSecret: 'B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk=', emailHashSecretGenerated: false });
    expect(() => loadConfig({ EMAIL_HASH_SECRET: 'short' })).toThrow(/16/);
  });

  it('LEDGER_PATH and LEDGER_RETENTION_DAYS (30–1825)', () => {
    expect(loadConfig({ LEDGER_PATH: '/var/data/audit-ledger.jsonl' }).ledgerPath).toBe('/var/data/audit-ledger.jsonl');
    expect(loadConfig({ LEDGER_RETENTION_DAYS: '30' }).ledgerRetentionDays).toBe(30);
    expect(() => loadConfig({ LEDGER_RETENTION_DAYS: '29' })).toThrow(/between/);
    expect(() => loadConfig({ LEDGER_RETENTION_DAYS: '1826' })).toThrow(/between/);
  });

  it('AUDIT_ALLOWLIST defaults to @offshorly.com and accepts emails or @domains', () => {
    expect([...loadConfig({}).auditAllowlist.domains]).toEqual(['offshorly.com']);
    const c = loadConfig({ AUDIT_ALLOWLIST: '@a.example, b@c.example  @d.example' });
    expect([...c.auditAllowlist.domains]).toEqual(['a.example', 'd.example']);
    expect([...c.auditAllowlist.emails]).toEqual(['b@c.example']);
    expect(() => loadConfig({ AUDIT_ALLOWLIST: 'not-an-email' })).toThrow(/AUDIT_ALLOWLIST/);
  });

  it('CRM_SYNC_ALLOWLISTED is true or false', () => {
    expect(loadConfig({ CRM_SYNC_ALLOWLISTED: 'true' }).crmSyncAllowlisted).toBe(true);
    expect(() => loadConfig({ CRM_SYNC_ALLOWLISTED: 'yes' })).toThrow(/CRM_SYNC_ALLOWLISTED/);
  });

  it('TWENTY_API_URL: https origin; http://localhost only outside production', () => {
    expect(loadConfig({ TWENTY_API_URL: 'https://api.twenty.com/' }).twentyApiUrl).toBe('https://api.twenty.com');
    expect(loadConfig({ TWENTY_API_URL: 'http://localhost:3000' }).twentyApiUrl).toBe('http://localhost:3000');
    expect(() => loadConfig({ NODE_ENV: 'production', TWENTY_API_URL: 'http://localhost:3000' })).toThrow(/https/);
    expect(() => loadConfig({ TWENTY_API_URL: 'http://crm.example' })).toThrow(/https/);
    expect(() => loadConfig({ TWENTY_API_URL: 'https://crm.example/rest' })).toThrow(/no path/);
    expect(loadConfig({ TWENTY_API_KEY: ' key ' }).twentyApiKey).toBe('key');
  });

  it('LEAD_WEBHOOK_URL is gone', () => {
    expect(loadConfig({ LEAD_WEBHOOK_URL: 'http://hooks.example/x' })).not.toHaveProperty('leadWebhookUrl');
  });
});

describe('loadLocalEnv', () => {
  it('skips in production and when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-env-'));
    const file = join(dir, '.env.local');
    writeFileSync(file, 'OA_TEST_ONLY_VAR=1\n');
    expect(loadLocalEnv(file, { NODE_ENV: 'production' })).toBe(false);
    expect(loadLocalEnv(join(dir, 'missing'), {})).toBe(false);
    expect(process.env.OA_TEST_ONLY_VAR).toBeUndefined();
    expect(loadLocalEnv(file, {})).toBe(true);
    expect(process.env.OA_TEST_ONLY_VAR).toBe('1');
    delete process.env.OA_TEST_ONLY_VAR;
  });
});

describe('Amendment 5 env (Phases 2–3)', () => {
  it('defaults', () => {
    expect(loadConfig({})).toMatchObject({
      sessionTtlHours: 24,
      feedbackPath: null,
      feedbackRetentionDays: 365,
      adminToken: null,
      shareLinks: 'on',
      reportsDir: null,
      shareRetentionDays: 30,
      shareMaxFiles: 5000,
      shareMinFreeMb: 150,
    });
  });

  it('parses and validates', () => {
    const c = loadConfig({
      SESSION_TTL_HOURS: '72',
      FEEDBACK_PATH: '/var/data/idea-feedback.jsonl',
      FEEDBACK_RETENTION_DAYS: '90',
      ADMIN_TOKEN: 'x'.repeat(32),
      SHARE_LINKS: 'OFF',
      REPORTS_DIR: '/var/data/reports',
      SHARE_RETENTION_DAYS: '365',
      SHARE_MAX_FILES: '10',
      SHARE_MIN_FREE_MB: '0',
    });
    expect(c).toMatchObject({ sessionTtlHours: 72, feedbackRetentionDays: 90, adminToken: 'x'.repeat(32), shareLinks: 'off', shareRetentionDays: 365, shareMaxFiles: 10, shareMinFreeMb: 0 });
    expect(() => loadConfig({ ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ SHARE_LINKS: 'maybe' })).toThrow(/SHARE_LINKS/);
    expect(() => loadConfig({ SESSION_TTL_HOURS: '0' })).toThrow(/SESSION_TTL_HOURS/);
    expect(() => loadConfig({ SESSION_TTL_HOURS: '73' })).toThrow(ConfigError);
    expect(() => loadConfig({ SHARE_RETENTION_DAYS: '366' })).toThrow(/SHARE_RETENTION_DAYS/);
    expect(() => loadConfig({ SHARE_MAX_FILES: 'lots' })).toThrow(/SHARE_MAX_FILES/);
  });
});
