// Check the Twenty CRM credentials with three read-only calls: list 1 person, find a person
// by a probe email and find a company by a probe domain (server/crm/twentyCheck.ts).
//
//   npm run twenty:check
//
// Reads TWENTY_API_URL and TWENTY_API_KEY (from .env.local outside production). Prints OK or
// FAILED with the HTTP status and a hint for each call. Never creates, updates or deletes, and
// never prints the key, an email address from the workspace or any record data.
import { loadConfig, loadLocalEnv } from '../server/config.js';
import { createTwentyClient } from '../server/crm/twenty.js';
import { runTwentyCheck } from '../server/crm/twentyCheck.js';

loadLocalEnv();
const config = loadConfig();
if (!config.twentyApiUrl || !config.twentyApiKey) {
  console.error('TWENTY_API_URL and TWENTY_API_KEY must both be set.');
  process.exit(1);
}

const { ok, lines } = await runTwentyCheck(createTwentyClient({ apiUrl: config.twentyApiUrl, apiKey: config.twentyApiKey }), config.twentyApiUrl);
for (const l of lines) (l.startsWith('OK') ? console.info : console.error)(l);
process.exit(ok ? 0 : 1);
