// Test helpers for the orchestrator and app: a mocked small business site, a stub WordPress.org
// client, controllable AI engines and a default app config. No network access.
import type { AiSection, BuyerFit } from '../../shared/types.js';
import type { AiEngine } from '../../server/audit/aiEngine.js';
import { fixtureEngine } from '../../server/audit/aiEngine.js';
import type { AuditDeps } from '../../server/audit/runAudit.js';
import type { AppConfig, AppDeps } from '../../server/app.js';
import type { WpOrgClient } from '../../server/cms/wordpressOrg.js';
import { createFetchSafe } from '../../server/site/fetchSafe.js';
import type { FetchLikeInit } from '../../server/site/fetchSafe.js';
import { mockFetch, mockResolve } from './_siteMock.js';
import type { MockRoute } from './_siteMock.js';

const H = { 'content-type': 'text/html; charset=utf-8' };
const para = (s: string) => `<p>${s}</p>`;

const HOME_TEXT = [
  'Acme Bookkeeping helps small firms across Yorkshire keep their accounts tidy every single month.',
  'Our team handles invoices, payroll and VAT returns so owners can focus on running the business.',
  'We work with cafés, builders, salons and independent shops that want clear numbers and friendly advice.',
  'Book a free call and we will explain exactly how our monthly service works for your firm.',
  'Clients tell us the biggest change is knowing where they stand without chasing paperwork.',
].map(para).join('');

export const homeHtml = (host: string) => `<!doctype html><html lang="en"><head>
<title>Acme Bookkeeping | Monthly bookkeeping for small firms</title>
<meta name="description" content="Monthly bookkeeping, payroll and VAT for small firms in Yorkshire.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://${host}/">
</head><body><h1>Bookkeeping for small firms</h1>${HOME_TEXT}
<a href="/services/">Services</a> <a href="/about/">About us</a>
<script src="https://js.hs-scripts.com/123.js"></script>
</body></html>`;

const innerHtml = (title: string) =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${para(
    'We help small firms with clear monthly bookkeeping and friendly advice. '.repeat(6),
  )}</body></html>`;

export const siteRoutes = (host = 'acme.example', home: Partial<MockRoute> = {}): Record<string, MockRoute> => ({
  [`https://${host}/`]: { body: homeHtml(host), headers: { ...H, 'strict-transport-security': 'max-age=63072000' }, ...home },
  [`https://${host}/services/`]: { body: innerHtml('Services'), headers: H },
  [`https://${host}/about/`]: { body: innerHtml('About us'), headers: H },
  [`https://${host}/robots.txt`]: { body: `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`, headers: { 'content-type': 'text/plain' } },
  [`http://${host}/`]: { status: 301, headers: { location: `https://${host}/` } },
});

export const thinRoutes = (host = 'thin.example'): Record<string, MockRoute> => ({
  [`https://${host}/`]: { body: '<html><head><title>App</title></head><body><div id="root"></div></body></html>', headers: H },
  [`https://${host}/robots.txt`]: { status: 404, body: 'nope', headers: H },
  [`https://${host}/sitemap.xml`]: { status: 404, body: 'nope', headers: H },
  [`http://${host}/`]: { status: 301, headers: { location: `https://${host}/` } },
});

export const stubWpOrg: WpOrgClient = {
  stableCheck: async () => null,
  plugin: async () => ({ directory: 'unknown', name: null, latest: null, lastUpdated: null }),
  theme: async () => ({ directory: 'unknown', name: null, latest: null, lastUpdated: null }),
};

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const sampleBuyerFit = (actions: BuyerFit['actions'] = []): BuyerFit => ({
  businessType: 'Bookkeeping firm',
  businessTypeInferred: true,
  persona: { role: 'Owner', size: '10-person firm', sector: 'Hospitality', trigger: 'Accounts are a mess' },
  personaInferred: true,
  score: 62,
  verdict: { summary: 'Clear offer, light on proof.', brutalTruth: 'No named clients.' },
  strengths: ['Says what it does'],
  criteria: [
    { name: 'Clarity', score: 8, reasoning: 'Clear.', weight: 'high' },
    { name: 'Proof', score: 4, reasoning: 'Thin.', weight: 'high' },
    { name: 'Relevance', score: 6, reasoning: 'Some.', weight: 'medium' },
    { name: 'Next step', score: 7, reasoning: 'Easy.', weight: 'low' },
  ],
  mismatchIndex: [],
  actions,
});

export const sampleAi = (): AiSection => ({
  business: { summary: 'A bookkeeping firm for small businesses.', customers: 'b2b' },
  opportunities: [
    {
      title: 'Faster invoice processing',
      process: 'Invoices are keyed in by hand.',
      basis: [{ kind: 'stack', techId: 'hubspot', name: 'HubSpot' }],
      aiApproach: 'Read invoices automatically and queue them for review.',
      efficiency: 'time-per-task',
      measureFirst: 'Count invoices per week.',
      confidence: 'likely',
      service: { id: 'ai-automation', name: 'AI Automation', url: 'https://offshorly.com/ai-automation/' },
    },
  ],
  notWorthIt: 'Client relationship calls.',
});

/** An engine whose results the test resolves by hand. */
export const controlledEngine = () => {
  const bf = deferred<BuyerFit>();
  const ai = deferred<{ status: 'ok'; ai: AiSection }>();
  let calls = 0;
  const engine: AiEngine = {
    mode: 'live',
    buyerFit: () => {
      calls++;
      return bf.promise;
    },
    opportunities: () => ai.promise,
  };
  return { engine, bf, ai, calls: () => calls };
};

export const auditDeps = (
  routes: Record<string, MockRoute | ((init: FetchLikeInit) => MockRoute)>,
  over: Partial<AuditDeps> = {},
): AuditDeps & { calls: string[] } => {
  const fetchImpl = mockFetch(routes);
  return {
    createFetchSafe: () => createFetchSafe({ fetchImpl, resolveAll: mockResolve() }),
    wpOrg: stubWpOrg,
    resolveTxt: async () => [],
    ai: fixtureEngine(),
    ...over,
    calls: fetchImpl.calls,
  };
};

export const appConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  aiMode: 'fixture',
  version: '0.0.0-test',
  isProduction: false,
  publicOrigin: 'https://audit.example',
  allowedOrigins: ['http://localhost:5173'],
  allowedFrameAncestors: ['https://offshorly.com', 'https://www.offshorly.com'],
  rateLimitHourly: 5,
  rateLimitDaily: 20,
  dailyAiAudits: 150,
  maxConcurrentAudits: 4,
  cacheTtlMin: 360,
  trustProxyHops: 1,
  leadWebhookUrl: null,
  typekitKitUrl: null,
  ...over,
});

export const appDeps = (over: Partial<AppDeps> = {}, routes = siteRoutes()): AppDeps => {
  const { calls: _calls, ...audit } = auditDeps(routes);
  return { config: appConfig(), audit, ...over };
};

export const ORIGIN = { origin: 'https://audit.example' };
