import { describe, expect, it } from 'vitest';
import { CHECKS, CHECK_IDS } from '../../shared/checks.js';
import {
  AI_SERVICE_IDS,
  CTA,
  PROOFS,
  PROOF_IDS,
  SERVICES,
  SERVICE_IDS,
  isServiceId,
  proofAllowedFor,
  serviceUrl,
} from '../../shared/services.js';
import { CHECK_TEXT } from '../../src/content/checkText.js';
import {
  COPY,
  CONFIDENCE_LABELS,
  CONFIDENCE_MEANINGS,
  EFFICIENCY_LABELS,
  ERROR_COPY,
  LOADING_STAGES,
  REGION_OPTIONS,
  TEAM_SIZE_OPTIONS,
} from '../../src/content/copy.js';
import { ERROR_CODES } from '../../src/lib/errors.js';

/** Collect every visitor-facing string, calling copy functions with sample arguments. */
const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') out.push(String((value as (...a: unknown[]) => unknown)(2, 'High')));
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
};


const visitorStrings = (): string[] => [
  ...collectStrings(CHECK_TEXT),
  ...collectStrings(COPY),
  ...collectStrings(EFFICIENCY_LABELS),
  ...collectStrings(CONFIDENCE_LABELS),
  ...collectStrings(CONFIDENCE_MEANINGS),
  ...collectStrings(LOADING_STAGES),
  ...collectStrings(TEAM_SIZE_OPTIONS),
  ...collectStrings(REGION_OPTIONS),
  ...ERROR_CODES.map((c) => ERROR_COPY[c]('The site did not respond.', 120)),
  ...collectStrings(PROOFS),
  ...collectStrings(CTA),
];

describe('check catalogue and wording', () => {
  it('has text for every CheckId', () => {
    expect(CHECK_IDS.length).toBe(39);
    for (const id of CHECK_IDS) {
      const t = CHECK_TEXT[id];
      expect(t, id).toBeDefined();
      expect(t.label.trim(), `${id} label`).not.toBe('');
      expect(t.fix.trim(), `${id} fix`).not.toBe('');
      expect(t.action.trim(), `${id} action`).not.toBe('');
    }
    expect(Object.keys(CHECK_TEXT).sort()).toEqual([...CHECK_IDS].sort());
  });

  it('has valid metadata for every check', () => {
    for (const id of CHECK_IDS) {
      const m = CHECKS[id];
      expect(m.weight, id).toBeGreaterThan(0);
      const prefix = id.split('-')[0];
      expect(m.section, id).toBe(prefix === 'sec' || prefix === 'wp' ? 'security' : 'health');
    }
    expect(CHECKS['spd-google-score'].rankable).toBe(false);
    expect(CHECK_IDS.filter((id) => !CHECKS[id].rankable)).toEqual(['spd-google-score']);
  });

  it('never uses "insecure" in static check text', () => {
    for (const id of CHECK_IDS) {
      expect(JSON.stringify(CHECK_TEXT[id]).toLowerCase(), id).not.toContain('insecure');
    }
  });
});

describe('service catalogue and proofs', () => {
  it('lists the planned AI and web services', () => {
    expect(AI_SERVICE_IDS.sort()).toEqual(
      [
        'ai-agent-development',
        'ai-automation',
        'ai-development-services',
        'ai-product-development',
        'ai-saas-enhancer',
        'dedicated-ai-teams',
        'free-ai-consultation',
      ].sort(),
    );
    expect(SERVICE_IDS.filter((id) => SERVICES[id].kind === 'web').sort()).toEqual(
      ['website-redesign', 'websites', 'wordpress'].sort(),
    );
    for (const id of SERVICE_IDS) {
      expect(SERVICES[id].id).toBe(id);
      expect(SERVICES[id].path).toMatch(/^\/[a-z0-9-]+\/$/);
      expect(serviceUrl(id)).toMatch(/^https:\/\/offshorly\.com\//);
    }
  });

  it('every proof serviceId exists and every proof id is consistent', () => {
    expect(PROOF_IDS.sort()).toEqual(
      ['compliance-tickets', 'contained-roi', 'lender-appraisal', 'lender-savings'].sort(),
    );
    for (const id of PROOF_IDS) {
      const p = PROOFS[id];
      expect(p.id).toBe(id);
      expect(p.serviceIds.length, id).toBeGreaterThan(0);
      for (const s of p.serviceIds) {
        expect(isServiceId(s), `${id} -> ${s}`).toBe(true);
        expect(proofAllowedFor(id, s)).toBe(true);
      }
      expect(p.path).toMatch(/^\/[a-z0-9/-]+\/$/);
    }
  });

  it('uses https CTA links', () => {
    // auditPage defaults to the tool's own origin ("/") until the owner names a page (Amendment 5).
    for (const [k, c] of Object.entries(CTA)) expect(c.url, k).toMatch(k === 'auditPage' ? /^(\/|https:\/\/)/ : /^https:\/\//);
  });
});

describe('visitor-facing wording rules', () => {
  const text = visitorStrings().join('\n');

  it('never says "vulnerable"', () => {
    expect(text).not.toMatch(/\bvulnerable\b/i);
  });

  it('never quotes the inconsistent lender figure or prices the proof of concept', () => {
    expect(text).not.toMatch(/\$\s?(25|40)\s?k|\$\s?(25|40),000/i);
    expect(text).not.toMatch(/fixed[- ]price/i);
    expect(text).not.toMatch(/proof of concept/i);
  });

  it('uses UK spelling for common words', () => {
    expect(text).not.toMatch(/\b(analyze|optimize|organization|color|behavior)\b/i);
  });

  it('formats rate-limit minutes', () => {
    expect(ERROR_COPY.rate_limited('', 60)).toContain('1 minute.');
    expect(ERROR_COPY.rate_limited('', 600)).toContain('10 minutes.');
    expect(ERROR_COPY.site_not_found('No site found at that address.')).toBe(
      'No site found at that address. Please check the address and try again.',
    );
  });

  it('has loading stages in time order', () => {
    const times = LOADING_STAGES.map((s) => s.afterSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
  });
});
