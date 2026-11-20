// WordPress analysis: versions from the page and linked files, then WordPress.org (and, when
// enabled, Wordfence) lookups. Target fetches here: the feed only if linked in <head> and same
// host, and the active theme's style.css only if linked and same host. Nothing else.
import type { WordPressInfo, WpComponent } from '../../shared/types.js';
import type { FetchSafe } from '../site/fetchSafe.js';
import { compareVersions, extractComponents, extractCoreVersion, findFeedUrl, findThemeStylesheet, parseStyleCss, xmlrpcAdvertised } from './version.js';
import type { Wordfence, WfEntry } from './wordfence.js';
import { aggregate } from './wordfence.js';
import type { WpOrgClient } from './wordpressOrg.js';
import { latestCoreVersion, stableStatusOf } from './wordpressOrg.js';

export const STALE_MONTHS = 24;
export const FEED_MAX_BYTES = 256_000;
export const STYLE_MAX_BYTES = 64_000;

export interface WordPressDeps {
  fetchSafe: FetchSafe;
  wpOrg: WpOrgClient;
  /** Only when WORDFENCE_API_KEY is set and the feed is indexed. */
  wordfence?: Wordfence | null;
  now?: () => number;
}

export interface WordPressHome {
  html: string;
  headers: Record<string, string>;
  finalUrl: string;
}

export const isStale = (lastUpdated: string | null | undefined, nowMs: number): boolean => {
  if (!lastUpdated) return false;
  const t = Date.parse(`${lastUpdated}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - STALE_MONTHS);
  return t < cutoff.getTime();
};

const tryFetchText = async (fetchSafe: FetchSafe, url: string | null, maxBytes: number, accept: string): Promise<string | null> => {
  if (!url) return null;
  try {
    const r = await fetchSafe(url, { requireOk: true, maxBytes, accept });
    return r.body;
  } catch {
    return null;
  }
};

export const analyseWordPress = async (home: WordPressHome, deps: WordPressDeps): Promise<WordPressInfo> => {
  const now = deps.now ?? Date.now;
  const feedUrl = findFeedUrl(home.html, home.finalUrl);
  const style = findThemeStylesheet(home.html, home.finalUrl);

  const [feedXml, css] = await Promise.all([
    tryFetchText(deps.fetchSafe, feedUrl, FEED_MAX_BYTES, 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5'),
    tryFetchText(deps.fetchSafe, style?.url ?? null, STYLE_MAX_BYTES, 'text/css,*/*;q=0.5'),
  ]);

  const core = extractCoreVersion(home.html, feedXml);
  const found = extractComponents(home.html, core.version);
  const styleInfo = css ? parseStyleCss(css) : null;
  if (style && !found.some((c) => c.type === 'theme' && c.slug === style.slug)) {
    found.unshift({ type: 'theme', slug: style.slug, version: null, versionSource: null });
  }
  if (style && styleInfo?.version) {
    const t = found.find((c) => c.type === 'theme' && c.slug === style.slug);
    if (t) {
      t.version = styleInfo.version;
      t.versionSource = 'stylesheet';
    }
  }

  const wf = deps.wordfence?.ready ? deps.wordfence : null;
  const [stable, infos] = await Promise.all([
    deps.wpOrg.stableCheck(),
    Promise.all(found.map((c) => (c.type === 'plugin' ? deps.wpOrg.plugin(c.slug) : deps.wpOrg.theme(c.slug)))),
  ]);

  const allMatches: WfEntry[] = [];
  const components: WpComponent[] = found.map((c, i) => {
    const info = infos[i]!;
    const matches = wf ? wf.match(c.type, c.slug, c.version) : [];
    allMatches.push(...matches);
    let status: WpComponent['status'] = 'unknown';
    if (matches.some((m) => m.patched)) status = 'fix_available';
    else if (c.version && info.latest) {
      const cmp = compareVersions(c.version, info.latest);
      if (cmp !== null) status = cmp < 0 ? 'outdated' : 'up_to_date';
    }
    const name = info.name ?? (c.type === 'theme' && style?.slug === c.slug ? styleInfo?.name ?? null : null);
    return {
      type: c.type,
      slug: c.slug,
      name,
      version: c.version,
      versionSource: c.versionSource,
      latest: info.latest,
      directory: info.directory,
      ...(info.lastUpdated ? { lastUpdated: info.lastUpdated } : {}),
      stale: info.directory === 'listed' && isStale(info.lastUpdated, now()),
      status,
    };
  });

  let coreStatus: WordPressInfo['core']['status'] = 'unknown';
  const coreLatest = stable ? latestCoreVersion(stable) : null;
  if (stable && core.version) coreStatus = stableStatusOf(stable, core.version) ?? 'unknown';
  if (wf && core.version) allMatches.push(...wf.match('core', 'wordpress', core.version));

  const known = wf ? aggregate(allMatches) : null;
  return {
    core: { version: core.version, source: core.source, latest: coreLatest, status: coreStatus },
    components,
    xmlrpcAdvertised: xmlrpcAdvertised(home.html, home.headers),
    versionExposed: core.versionExposed,
    vulnSource: wf ? 'wordfence' : null,
    ...(known ? { knownIssues: known } : {}),
  };
};
