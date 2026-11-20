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
      leadWebhookUrl: null,
      typekitKitUrl: null,
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
    expect(() => loadConfig({ LEAD_WEBHOOK_URL: 'http://hooks.example/x' })).toThrow(/https/);
    expect(() => loadConfig({ TYPEKIT_KIT_URL: 'https://evil.example/x.css' })).toThrow(/typekit/);
    expect(loadConfig({ TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
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
