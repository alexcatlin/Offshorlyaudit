// Form helpers: URL normalisation and request building. Pure.
import type { AuditStartBody, Persona, TeamSize } from '../../shared/types.js';

export interface FormValues {
  url: string;
  businessType: string;
  role: string;
  size: string;
  sector: string;
  trigger: string;
  teamSize: TeamSize | '';
  timeSink: string;
  email: string;
  name: string;
  marketingOptIn: boolean;
}

export const EMPTY_FORM: FormValues = {
  url: '',
  businessType: '',
  role: '',
  size: '',
  sector: '',
  trigger: '',
  teamSize: '',
  timeSink: '',
  email: '',
  name: '',
  marketingOptIn: false,
};

export const LIMITS = {
  url: 500,
  businessType: 100,
  role: 200,
  size: 200,
  sector: 200,
  trigger: 300,
  timeSink: 200,
  email: 254,
  name: 100,
} as const;

const TEAM_SIZES: readonly TeamSize[] = ['1-10', '11-50', '51-200', '200+'];

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'empty' | 'invalid' };

/** Adds https:// if missing and checks the result looks like a public web address. */
export const normaliseUrlInput = (raw: string): UrlCheck => {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > LIMITS.url || /\s/.test(trimmed)) return { ok: false, reason: 'invalid' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  const host = parsed.hostname;
  // Needs a dot and a plausible top-level part; the server does the real (SSRF-safe) checks.
  if (!host.includes('.') || host.endsWith('.') || host.startsWith('.')) return { ok: false, reason: 'invalid' };
  return { ok: true, url: parsed.toString() };
};

export type EmailCheck = { ok: true; email: string } | { ok: false; reason: 'empty' | 'invalid' };

/** Loose syntax check only (something@domain.tld); the server does the real checks. */
export const checkEmailInput = (raw: string): EmailCheck => {
  const email = raw.trim();
  if (!email) return { ok: false, reason: 'empty' };
  if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return { ok: false, reason: 'invalid' };
  return { ok: true, email };
};

const clip = (v: string, max: number): string => v.trim().slice(0, max);

/**
 * Builds the API body. Blank optional fields are left out, never replaced by defaults.
 * `name` is sent only when non-blank and `marketingOptIn` only when ticked.
 */
export const buildRequest = (values: FormValues, url: string): AuditStartBody => {
  const req: AuditStartBody = { url, email: values.email.trim() };
  const name = clip(values.name, LIMITS.name);
  if (name) req.name = name;
  if (values.marketingOptIn === true) req.marketingOptIn = true;
  const businessType = clip(values.businessType, LIMITS.businessType);
  if (businessType) req.businessType = businessType;

  const persona: Partial<Persona> = {};
  for (const key of ['role', 'size', 'sector', 'trigger'] as const) {
    const v = clip(values[key], LIMITS[key]);
    if (v) persona[key] = v;
  }
  if (Object.keys(persona).length) req.persona = persona;

  if (values.teamSize && TEAM_SIZES.includes(values.teamSize)) req.teamSize = values.teamSize;
  const timeSink = clip(values.timeSink, LIMITS.timeSink);
  if (timeSink) req.timeSink = timeSink;
  return req;
};
