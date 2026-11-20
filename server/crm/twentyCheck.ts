// Read-only checks behind `npm run twenty:check`. Every call is a GET: nothing is created,
// updated or deleted. Output carries statuses, counts and field presence only: never the key,
// an email address from the workspace or any record contents.
import { TwentyError } from './twenty.js';
import type { TwentyClient } from './twenty.js';

const HINTS: Record<number, string> = {
  400: 'the request was refused: the filter syntax may differ on this Twenty version.',
  401: 'the API key was refused: check TWENTY_API_KEY (and its expiry date).',
  403: "the key's role can't read this object: give it read + create + update on People, Companies, Notes and note targets.",
  404: 'not found: check TWENTY_API_URL (cloud is https://api.twenty.com; self-hosted is your server origin).',
  429: 'rate limited (Twenty allows 100 requests per minute): wait a minute and retry.',
};

/** Probe values on a reserved TLD: they can't belong to a real contact. */
export const PROBE_EMAIL = 'nobody@invalid.example';
export const PROBE_DOMAIN = 'invalid.example';

export interface TwentyCheckResult {
  ok: boolean;
  lines: string[];
}

const failure = (label: string, e: unknown, apiUrl: string): string => {
  if (e instanceof TwentyError) {
    const hint = e.status === null ? `couldn't reach ${apiUrl} (network error or timeout).` : (HINTS[e.status] ?? 'unexpected response.');
    return `FAILED ${label} (${e.status ?? 'network'}): ${hint}`;
  }
  return `FAILED ${label}: ${e instanceof Error ? e.name : 'error'}`;
};

export const runTwentyCheck = async (client: TwentyClient, apiUrl: string): Promise<TwentyCheckResult> => {
  const lines: string[] = [];
  let ok = true;

  try {
    const { count, companyIdKey } = await client.ping();
    lines.push(`OK list people: ${apiUrl} accepted the key (${count} record${count === 1 ? '' : 's'} returned).`);
    if (companyIdKey === false) {
      lines.push('WARN list people: the Person record has no companyId key; the sync would not see an existing company link.');
    }
  } catch (e) {
    ok = false;
    lines.push(failure('list people', e, apiUrl));
  }

  try {
    const found = await client.findPersonByEmail(PROBE_EMAIL);
    lines.push(`OK find person by email (${found ? 1 : 0} match${found ? '' : 'es'}).`);
  } catch (e) {
    ok = false;
    lines.push(failure('find person by email', e, apiUrl));
  }

  try {
    const found = await client.findCompanyByDomain(PROBE_DOMAIN);
    lines.push(`OK find company by domain (${found ? 1 : 0} match${found ? '' : 'es'}).`);
  } catch (e) {
    ok = false;
    lines.push(failure('find company by domain', e, apiUrl));
  }

  return { ok, lines };
};
