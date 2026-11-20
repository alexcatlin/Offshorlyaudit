// Twenty CRM REST client (Amendment 3 §4). The ONLY file that knows Twenty's endpoint shapes.
//
// Sources, checked 2026-11-20:
// - docs.twenty.com/developers/extend/api.md: base URL (cloud https://api.twenty.com/,
//   self-hosted https://{your-domain}/), Core API under /rest/, `Authorization: Bearer <key>`,
//   `fields` query parameter, `depth=0` returns a many-to-one join column such as `companyId`,
//   rate limit 100 requests/minute, batch size 60.
// - twentyhq/twenty main, packages/twenty-server/src/engine/api/rest/:
//   core/controllers/rest-api-core.controller.ts: GET/POST/PATCH `/rest/{objectNamePlural}[/{id}]`;
//   core/handlers/rest-api-find-many.handler.ts: list → `{data:{<plural>:[...]}, totalCount, pageInfo}`;
//   core/handlers/rest-api-create-one.handler.ts: create → `{data:{create<Singular>:{...}}}`;
//   core/handlers/rest-api-update-one.handler.ts: update → `{data:{update<Singular>:{...}}}`;
//   input-request-parsers/filter-parser-utils/*: `filter=field.sub[comparator]:value`,
//   comparators eq/neq/in/containsAny/is/gt/gte/lt/lte/startsWith/endsWith/like/ilike; a
//   double-quoted value is unquoted and protects commas and brackets.
// - twentyhq/twenty main, packages/twenty-server/src/modules/{person,company,note}/standard-objects/*:
//   Person `name {firstName,lastName}`, `emails {primaryEmail,additionalEmails}`, `companyId`;
//   Company `name`, `domainName {primaryLinkUrl,primaryLinkLabel,secondaryLinks}`;
//   Note `title`, `bodyV2 {markdown,blocknote,tiptap}`; NoteTarget `noteId`, `targetPersonId`,
//   `targetCompanyId` (REST plural `noteTargets`).
// - engine/core-modules/record-transformer/utils/transform-rich-text.util.ts: a `bodyV2` with only
//   `markdown` is converted server-side to the rich-text document.
// - engine/core-modules/actor/utils/build-created-by-from-api-key.util.ts: records created with an
//   API key get `createdBy {source:'API', name:<key name>}`.
//
// Error handling: never read or log a response body (Twenty may echo the email back). Errors
// carry the HTTP status only (null = network failure or timeout).

export type TwentyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TwentyPerson {
  id: string;
  hasName: boolean;
  companyId: string | null;
}

export interface TwentyClient {
  findPersonByEmail(email: string): Promise<TwentyPerson | null>;
  createPerson(p: { firstName: string; lastName: string; email: string; companyId?: string }): Promise<string>;
  updatePerson(id: string, patch: { firstName?: string; lastName?: string; companyId?: string }): Promise<void>;
  findCompanyByDomain(domain: string): Promise<string | null>;
  createCompany(c: { name: string; domain: string }): Promise<string>;
  /** Creates the Note only; returns its id. Link it with `linkNote`. */
  createNote(n: { title: string; markdown: string }): Promise<string>;
  /** One NoteTarget: the Note to a Person or to a Company. */
  linkNote(noteId: string, target: { personId: string } | { companyId: string }): Promise<void>;
  /** One read (list 1 person) for `npm run twenty:check`: the record count and whether the
   *  record carries a `companyId` key (null when no record came back). Never record contents. */
  ping(): Promise<{ count: number; companyIdKey: boolean | null }>;
}

export class TwentyError extends Error {
  /** HTTP status; null = network failure or timeout. */
  readonly status: number | null;
  constructor(status: number | null, what: string) {
    super(`Twenty ${what} failed (${status ?? 'network'})`);
    this.name = 'TwentyError';
    this.status = status;
  }
}

export const TWENTY_TIMEOUT_MS = 8_000;

export interface TwentyClientOptions {
  /** Origin, e.g. https://api.twenty.com (cloud) or the self-hosted server origin. */
  apiUrl: string;
  apiKey: string;
  fetchImpl?: TwentyFetch;
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Host of a stored domainName URL, lowercased, without scheme, "www." or path. */
export const hostOfLink = (url: string): string =>
  url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');

/** A filter value in double quotes. Callers only pass validated emails/domains (no `"`). */
const quoted = (v: string): string => `"${v.replace(/"/g, '')}"`;

export const createTwentyClient = (opts: TwentyClientOptions): TwentyClient => {
  const base = opts.apiUrl.replace(/\/+$/, '');
  const fetchImpl: TwentyFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? TWENTY_TIMEOUT_MS;

  const call = async (what: string, method: 'GET' | 'POST' | 'PATCH', path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    let res: Awaited<ReturnType<TwentyFetch>>;
    try {
      res = await fetchImpl(`${base}/rest/${path}${qs}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow a redirect: it would carry the Bearer key to another location.
        redirect: 'error',
      });
    } catch {
      throw new TwentyError(null, what);
    }
    if (!res.ok) throw new TwentyError(res.status, what);
    try {
      return await res.json();
    } catch {
      throw new TwentyError(res.status, `${what} (unreadable response)`);
    }
  };

  const listOf = (r: unknown, plural: string): Record<string, unknown>[] => {
    const data = isObj(r) && isObj(r.data) ? r.data[plural] : undefined;
    return Array.isArray(data) ? data.filter(isObj) : [];
  };

  const createdId = (r: unknown, key: string, what: string): string => {
    const rec = isObj(r) && isObj(r.data) ? r.data[key] : undefined;
    const id = isObj(rec) ? rec.id : undefined;
    if (typeof id !== 'string' || !id) throw new TwentyError(200, `${what} (no id)`);
    return id;
  };

  return {
    async findPersonByEmail(email) {
      // ilike = case-insensitive (contacts added by hand may be "Jo@Acme.com"); `_` and `%`
      // act as wildcards there. Twenty's filter syntax documents no escape for them, so the
      // match is confirmed exactly here, with room for a few wildcard near-misses.
      const want = email.toLowerCase();
      const r = await call('find person', 'GET', 'people', {
        filter: `emails.primaryEmail[ilike]:${quoted(email)}`,
        limit: '10',
        depth: '0',
      });
      const p = listOf(r, 'people').find((x) => {
        const primary = isObj(x.emails) ? x.emails.primaryEmail : undefined;
        return typeof primary === 'string' && primary.trim().toLowerCase() === want;
      });
      if (!p || typeof p.id !== 'string') return null;
      const name = isObj(p.name) ? p.name : {};
      const hasName = [name.firstName, name.lastName].some((v) => typeof v === 'string' && v.trim() !== '');
      const companyId = typeof p.companyId === 'string' && p.companyId ? p.companyId : null;
      return { id: p.id, hasName, companyId };
    },

    async createPerson(p) {
      const r = await call('create person', 'POST', 'people', undefined, {
        name: { firstName: p.firstName, lastName: p.lastName },
        emails: { primaryEmail: p.email },
        ...(p.companyId ? { companyId: p.companyId } : {}),
      });
      return createdId(r, 'createPerson', 'create person');
    },

    async updatePerson(id, patch) {
      const body: Record<string, unknown> = {};
      if (patch.firstName !== undefined || patch.lastName !== undefined) {
        body.name = { firstName: patch.firstName ?? '', lastName: patch.lastName ?? '' };
      }
      if (patch.companyId) body.companyId = patch.companyId;
      if (!Object.keys(body).length) return;
      await call('update person', 'PATCH', `people/${encodeURIComponent(id)}`, undefined, body);
    },

    async findCompanyByDomain(domain) {
      // Stored URLs vary ("https://acme.com", "acme.com", "https://www.acme.com/"): match
      // loosely on the server, then exactly on the normalised host here. A short domain
      // ("a.io") matches many unrelated links, so take a full page (60, Twenty's batch size)
      // rather than risk the right record falling past the limit.
      const d = domain.toLowerCase();
      const r = await call('find company', 'GET', 'companies', {
        filter: `domainName.primaryLinkUrl[ilike]:${quoted(`%${d}%`)}`,
        limit: '60',
        depth: '0',
      });
      for (const c of listOf(r, 'companies')) {
        const link = isObj(c.domainName) ? c.domainName.primaryLinkUrl : undefined;
        if (typeof c.id === 'string' && typeof link === 'string' && hostOfLink(link) === d) return c.id;
      }
      return null;
    },

    async createCompany(c) {
      const r = await call('create company', 'POST', 'companies', undefined, {
        name: c.name,
        domainName: { primaryLinkUrl: `https://${c.domain}` },
      });
      return createdId(r, 'createCompany', 'create company');
    },

    async createNote(n) {
      const r = await call('create note', 'POST', 'notes', undefined, { title: n.title, bodyV2: { markdown: n.markdown } });
      return createdId(r, 'createNote', 'create note');
    },

    async linkNote(noteId, target) {
      const body = 'personId' in target ? { noteId, targetPersonId: target.personId } : { noteId, targetCompanyId: target.companyId };
      await call('link note', 'POST', 'noteTargets', undefined, body);
    },

    async ping() {
      const people = listOf(await call('list people', 'GET', 'people', { limit: '1', depth: '0' }), 'people');
      const first = people[0];
      return { count: people.length, companyIdKey: first ? 'companyId' in first : null };
    },
  };
};
