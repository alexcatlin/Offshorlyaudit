// Display name for a WordPress plugin or theme, shared by the server checks and the UI panel.
// Names and slugs come from the audited page and WordPress.org, so both are untrusted: tags and
// control characters are stripped, length is capped at 50, and a name using a banned word
// ("vulnerable", "insecure") is never shown (PLAN "WordPress security" wording rules).
import type { WpComponent } from './types.js';

export const BANNED_NAME_WORDS = /vulnerab|insecure/i;

const clean = (s: string): string => {
  const t = s.replace(/<[^<>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= 50) return t;
  // Long directory names ("Jetpack – WP Security, Backup, Speed, & Growth"): keep the part before a dash, else cut at a word.
  const head = t.split(/\s[–—-]\s/)[0]!;
  if (head.length >= 3 && head.length <= 50) return head;
  return `${t.slice(0, 50).replace(/\s+\S*$/, '')}…`;
};

/** Directory/stylesheet name, sanitised, else the slug, else "a plugin" / "a theme". */
export const displayName = (c: Pick<WpComponent, 'name' | 'slug' | 'type'>): string => {
  const name = c.name ? clean(c.name) : '';
  if (name && !BANNED_NAME_WORDS.test(name)) return name;
  const slug = clean(c.slug);
  if (slug && !BANNED_NAME_WORDS.test(slug)) return slug;
  return c.type === 'plugin' ? 'a plugin' : 'a theme';
};
