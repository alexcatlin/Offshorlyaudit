// Map WordPressInfo to the five wp-* checks. Wording rules (PLAN "WordPress security"):
// facts only; never the word "vulnerable"; "insecure" only when WordPress.org's stable-check
// says so; "security fix available" only on a Wordfence match. No CVE ids, titles or links.
import { displayName } from '../../shared/displayName.js';
import type { CheckResult, WordPressInfo, WpComponent } from '../../shared/types.js';

// Re-exported for existing callers; the shared copy is also used by the UI.
export { displayName };

const SOURCE_TEXT: Record<'generator' | 'feed' | 'asset', string> = {
  generator: "the page's generator tag",
  feed: "the site's feed",
  asset: "the page's file links",
};

const listNames = (items: string[], max = 3): string =>
  items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;

export const coreCheck = (wp: WordPressInfo): CheckResult => {
  const { version, source, latest, status } = wp.core;
  if (!version) return { id: 'wp-core-version', status: 'info', detail: 'Version not shown publicly.' };
  const seen = source ? ` (seen in ${SOURCE_TEXT[source]})` : '';
  const latestText = latest ? `; latest is ${latest}` : '';
  switch (status) {
    case 'insecure':
      return {
        id: 'wp-core-version',
        status: 'fail',
        detail: `Running ${version}${seen}, which WordPress.org lists as insecure${latestText}.`,
      };
    case 'outdated':
      return {
        id: 'wp-core-version',
        status: 'warn',
        detail: `Running ${version}${seen}${latestText}. Updates often include security fixes.`,
      };
    case 'latest':
      return { id: 'wp-core-version', status: 'pass', detail: `Running ${version}${seen}, the latest version.` };
    default:
      return {
        id: 'wp-core-version',
        status: 'info',
        detail: `Running ${version}${seen}; we couldn't compare it with WordPress.org's release list.`,
      };
  }
};

const versionPair = (c: WpComponent): string =>
  c.version && c.latest ? ` (running ${c.version}, latest ${c.latest})` : c.version ? ` (running ${c.version})` : '';

/** Shared logic for wp-plugins and wp-theme. */
const componentCheck = (id: 'wp-plugins' | 'wp-theme', items: WpComponent[]): CheckResult => {
  const noun = id === 'wp-plugins' ? 'plugin' : 'theme';
  const nouns = `${noun}s`;
  if (!items.length) {
    return { id, status: 'info', detail: `No ${noun === 'plugin' ? 'plugins' : 'theme'} visible in the page's file links.` };
  }
  const total = items.length;
  const of = (k: number): string => (total === 1 ? '' : `${k} of ${total} detected ${nouns}: `);

  const fix = items.filter((c) => c.status === 'fix_available');
  const closed = items.filter((c) => c.directory === 'closed');
  if (fix.length || closed.length) {
    const parts: string[] = [];
    if (fix.length) {
      parts.push(`security fix available for ${listNames(fix.map((c) => `${displayName(c)}${versionPair(c)}`))}`);
    }
    if (closed.length) {
      parts.push(
        // Closed only: WordPress.org's closure reason is never shown (it can read as a verdict on the site).
        `no longer available in the WordPress.org directory (closed): ${listNames(closed.map(displayName))}`,
      );
    }
    const k = new Set([...fix, ...closed]).size;
    const text = `${of(k)}${parts.join('; ')}.`;
    return { id, status: 'fail', detail: text.charAt(0).toUpperCase() + text.slice(1) };
  }

  const outdated = items.filter((c) => c.status === 'outdated');
  const stale = items.filter((c) => c.stale);
  if (outdated.length || stale.length) {
    const parts: string[] = [];
    if (outdated.length) {
      parts.push(
        total === 1
          ? `${displayName(outdated[0]!)} is behind the latest version${versionPair(outdated[0]!)}`
          : `${outdated.length} of ${total} detected ${nouns} are behind the latest version: ${listNames(
              outdated.map((c) => `${displayName(c)}${versionPair(c)}`),
            )}`,
      );
    }
    if (stale.length) {
      parts.push(
        `${listNames(stale.map(displayName))} ${stale.length === 1 ? 'has' : 'have'} had no update in the WordPress.org directory for over two years`,
      );
    }
    return { id, status: 'warn', detail: `${parts.join('. ')}. Updates often include security fixes.` };
  }

  const current = items.filter((c) => c.status === 'up_to_date');
  if (current.length) {
    const detail =
      current.length === total
        ? total === 1
          ? `${displayName(current[0]!)} is up to date${current[0]!.version ? ` (${current[0]!.version})` : ''}.`
          : `All ${total} detected ${nouns} are up to date.`
        : `${current.length} of ${total} detected ${nouns} show a version, and ${current.length === 1 ? 'it is' : 'all are'} up to date. The rest don't show a version publicly.`;
    return { id, status: 'pass', detail };
  }

  const notListed = items.filter((c) => c.directory === 'not_listed');
  if (notListed.length === total) {
    return {
      id,
      status: 'info',
      detail:
        total === 1
          ? `${displayName(items[0]!)}${items[0]!.version ? ` ${items[0]!.version}` : ''} is a custom or premium ${noun}, not in the WordPress.org directory, so there is no public version to compare.`
          : `${total} detected ${nouns} are custom or premium, not in the WordPress.org directory, so there is no public version to compare.`,
    };
  }
  return {
    id,
    status: 'info',
    detail:
      total === 1
        ? `${displayName(items[0]!)} detected; its version isn't shown publicly or couldn't be compared.`
        : `${total} ${nouns} detected; their versions aren't shown publicly or couldn't be compared.`,
  };
};

export const pluginsCheck = (wp: WordPressInfo): CheckResult =>
  componentCheck('wp-plugins', wp.components.filter((c) => c.type === 'plugin'));

export const themeCheck = (wp: WordPressInfo): CheckResult =>
  componentCheck('wp-theme', wp.components.filter((c) => c.type === 'theme'));

export const xmlrpcCheck = (wp: WordPressInfo): CheckResult =>
  wp.xmlrpcAdvertised
    ? { id: 'wp-xmlrpc', status: 'warn', detail: 'The page advertises the XML-RPC endpoint (pingback link or X-Pingback header).' }
    : { id: 'wp-xmlrpc', status: 'pass', detail: "The page doesn't advertise XML-RPC." };

export const versionExposedCheck = (wp: WordPressInfo): CheckResult =>
  wp.versionExposed
    ? {
        id: 'wp-version-exposed',
        status: 'warn',
        detail: `The WordPress version${wp.core.version ? ` (${wp.core.version})` : ''} is shown in ${
          wp.core.source === 'feed' ? "the site's feed" : "the page's generator tag"
        }.`,
      }
    : { id: 'wp-version-exposed', status: 'pass', detail: "The WordPress version isn't shown in the generator tag or feed." };

export const wordpressChecks = (wp: WordPressInfo): CheckResult[] => [
  coreCheck(wp),
  pluginsCheck(wp),
  themeCheck(wp),
  xmlrpcCheck(wp),
  versionExposedCheck(wp),
];
