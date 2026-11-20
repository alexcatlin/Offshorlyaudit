// Fire-and-forget CRM sync (Amendment 3 §4). The route calls `enqueue` and moves on: nothing
// here is awaited by a request, and nothing here can change a response.
//
// In-memory queue, concurrency 1 (two jobs for one email can't race into duplicate People),
// bounded at 500 (oldest dropped). Each Twenty step is retried on 429, 5xx or a network
// failure after 2 s, 10 s and 60 s; any other 4xx is not retried. Jobs are lost on restart:
// `drain` waits a few seconds on shutdown and reports how many were dropped.
//
// Logs: {emailHash: <12 hex>, domain, step, status}. Never the email, never a Twenty body.
import type { AiResult, BuyerFitResult } from '../../shared/types.js';
import { emailDomain, logHash } from '../lead/email.js';
import { isFreemailDomain } from '../lead/freemail.js';
import type { AuditEntry } from '../routes/audit.js';
import { buildNote } from './summary.js';
import type { CrmLead } from './summary.js';
import { TwentyError } from './twenty.js';
import type { TwentyClient } from './twenty.js';

export type { CrmLead } from './summary.js';

export interface CrmSync {
  enqueue(lead: CrmLead, entry: AuditEntry): void;
  /** Waits up to `ms` for queued jobs; resolves with the number left undone. */
  drain(ms: number): Promise<number>;
}

export type CrmLog = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown>) => void;

export interface CrmSyncOptions {
  client: TwentyClient;
  log: CrmLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Cap on waiting for the AI results before building the Note. */
  resultWaitMs?: number;
  retryDelaysMs?: readonly number[];
  maxQueue?: number;
  dedupeTtlMs?: number;
}

export const CRM_RESULT_WAIT_MS = 100_000;
export const CRM_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const;
export const CRM_MAX_QUEUE = 500;
export const CRM_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX = 10_000;

/** The Company is only touched when the email domain and the audited domain are the same
 *  organisation (equal, or one a subdomain of the other) and the email isn't free-mail. */
export const companyDomainFor = (email: string, auditedDomain: string): string | null => {
  const e = emailDomain(email).replace(/^www\./, '');
  const a = auditedDomain.toLowerCase().replace(/^www\./, '');
  if (!e || !a || isFreemailDomain(e)) return null;
  if (e === a || e.endsWith(`.${a}`) || a.endsWith(`.${e}`)) return a;
  return null;
};

/** "Jo Anne Smith" → {firstName: "Jo", lastName: "Anne Smith"}. */
export const splitName = (name: string | undefined): { firstName: string; lastName: string } => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
};

const retryable = (e: unknown): boolean =>
  e instanceof TwentyError && (e.status === null || e.status === 429 || e.status >= 500);

const wait = <T>(p: Promise<T> | null, ms: number): Promise<T | null> => {
  if (!p) return Promise.resolve(null);
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p.catch(() => null), t]).finally(() => clearTimeout(timer));
};

interface Job {
  lead: CrmLead;
  entry: AuditEntry;
}

class StepFailed extends Error {}

export const createCrmSync = (opts: CrmSyncOptions): CrmSync => {
  const { client, log } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const delays = opts.retryDelaysMs ?? CRM_RETRY_DELAYS_MS;
  const maxQueue = opts.maxQueue ?? CRM_MAX_QUEUE;
  const dedupeTtl = opts.dedupeTtlMs ?? CRM_DEDUPE_TTL_MS;
  const resultWait = opts.resultWaitMs ?? CRM_RESULT_WAIT_MS;

  const queue: Job[] = [];
  const seen = new Map<string, number>();
  let running = false;
  let idle: (() => void)[] = [];

  const step = async <T>(name: string, meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const status = e instanceof TwentyError ? (e.status ?? 'network') : 'error';
        const delay = delays[attempt];
        if (retryable(e) && delay !== undefined) {
          log('warn', 'crm retry', { ...meta, step: name, status, attempt: attempt + 1 });
          await sleep(delay);
          continue;
        }
        log('warn', 'crm step failed', { ...meta, step: name, status });
        throw new StepFailed(name);
      }
    }
  };

  const run = async ({ lead, entry }: Job): Promise<void> => {
    const report = entry.report;
    const meta = { emailHash: logHash(lead.emailHash), domain: report.domain };
    const [buyerFit, ai] = await Promise.all([
      wait<BuyerFitResult>(entry.buyerFit, resultWait),
      wait<AiResult>(entry.ai, resultWait),
    ]);
    const note = buildNote({ lead, report, buyerFit, ai });

    const companyDomain = companyDomainFor(lead.email, report.domain);
    let companyId: string | undefined;
    if (companyDomain) {
      // A failed company step (find or create) is already logged by `step`; carry on without
      // the Company so the Person and Note still land.
      try {
        companyId = await step('company', meta, async () => {
          const found = await client.findCompanyByDomain(companyDomain);
          return found ?? (await client.createCompany({ name: companyDomain, domain: companyDomain }));
        });
      } catch (e) {
        if (!(e instanceof StepFailed)) throw e;
      }
    }

    const personId = await step('person', meta, async () => {
      const found = await client.findPersonByEmail(lead.email);
      if (!found) {
        return client.createPerson({ ...splitName(lead.name), email: lead.email, ...(companyId ? { companyId } : {}) });
      }
      // Existing Person: fill blanks only, never overwrite.
      const patch: { firstName?: string; lastName?: string; companyId?: string } = {};
      if (!found.hasName && lead.name) Object.assign(patch, splitName(lead.name));
      if (!found.companyId && companyId) patch.companyId = companyId;
      if (Object.keys(patch).length) await client.updatePerson(found.id, patch);
      return found.id;
    });

    const noteId = await step('note', meta, () => client.createNote({ title: note.title, markdown: note.markdown }));
    // Separate steps: a retried link never creates a second Note or a duplicate target.
    await step('note link person', meta, () => client.linkNote(noteId, { personId }));
    if (companyId) {
      const cid = companyId;
      await step('note link company', meta, () => client.linkNote(noteId, { companyId: cid }));
    }
    log('info', 'crm synced', { ...meta, step: 'done', status: 'ok', company: !!companyId });
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          await run(job);
        } catch (e) {
          if (!(e instanceof StepFailed)) {
            log('error', 'crm job failed', {
              emailHash: logHash(job.lead.emailHash),
              domain: job.entry.report.domain,
              step: 'job',
              status: e instanceof Error ? e.name : 'error',
            });
          }
        }
      }
    } finally {
      running = false;
      const waiters = idle;
      idle = [];
      for (const w of waiters) w();
    }
  };

  return {
    enqueue(lead, entry) {
      const t = now();
      const k = `${lead.emailHash}|${entry.report.domain}`;
      const until = seen.get(k);
      if (until !== undefined && until > t) return;
      seen.delete(k);
      seen.set(k, t + dedupeTtl);
      if (seen.size > DEDUPE_MAX) {
        for (const [key, exp] of seen) if (exp <= t || seen.size > DEDUPE_MAX) seen.delete(key);
      }
      queue.push({ lead, entry });
      if (queue.length > maxQueue) {
        const dropped = queue.shift()!;
        log('warn', 'crm queue full, dropped oldest', {
          emailHash: logHash(dropped.lead.emailHash),
          domain: dropped.entry.report.domain,
          step: 'queue',
          status: 'dropped',
        });
      }
      void pump();
    },

    async drain(ms) {
      if (!running && !queue.length) return 0;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((r) => idle.push(r)),
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
      clearTimeout(timer);
      return queue.length + (running ? 1 : 0);
    },
  };
};
