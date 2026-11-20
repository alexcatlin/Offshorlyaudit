// Check catalogue: section, weight and ranking metadata per CheckId.
// Weights and impact/effort/owner follow BUILD_GUIDE §5.7, plus the WordPress and
// PageSpeed values from docs/PLAN.md Phase 1.
import type { CheckId, CheckMeta, Lvl, Owner } from './types.js';

const sec = (weight: number, impact: Lvl, effort: Lvl, owner: Owner = 'developer'): CheckMeta => ({
  section: 'security',
  weight,
  impact,
  effort,
  owner,
  rankable: true,
});

const health = (weight: number, impact: Lvl, effort: Lvl, owner: Owner = 'developer'): CheckMeta => ({
  section: 'health',
  weight,
  impact,
  effort,
  owner,
  rankable: true,
});

export const CHECKS: Record<CheckId, CheckMeta> = {
  // Security basics
  'sec-https': sec(3, 'high', 'low'),
  'sec-redirect': sec(2, 'medium', 'low'),
  'sec-hsts': sec(2, 'medium', 'low'),
  'sec-csp': sec(2, 'medium', 'medium'),
  'sec-frame': sec(1, 'low', 'low'),
  'sec-nosniff': sec(1, 'low', 'low'),
  'sec-referrer': sec(1, 'low', 'low'),
  'sec-cookies': sec(1, 'low', 'low'),
  'sec-disclosure': sec(1, 'low', 'low'),
  'sec-mixed': sec(2, 'medium', 'low'),
  'sec-spf': sec(2, 'high', 'low'),
  'sec-dmarc': sec(2, 'high', 'low'),

  // WordPress (security section)
  'wp-core-version': sec(3, 'high', 'low'),
  'wp-plugins': sec(3, 'high', 'low'),
  'wp-theme': sec(1, 'medium', 'low'),
  'wp-xmlrpc': sec(1, 'low', 'low'),
  'wp-version-exposed': sec(0.5, 'low', 'low'),

  // Website health: SEO
  'seo-title': health(3, 'high', 'low', 'marketing'),
  'seo-description': health(2, 'medium', 'low', 'marketing'),
  'seo-h1': health(2, 'medium', 'low'),
  'seo-indexable': health(3, 'high', 'low'),
  'seo-content': health(2, 'medium', 'medium', 'marketing'),
  'seo-sitemap': health(2, 'medium', 'low'),
  'seo-canonical': health(1, 'low', 'low'),
  'seo-og': health(1, 'medium', 'low', 'marketing'),
  'seo-alt': health(1, 'low', 'medium', 'marketing'),

  // Website health: AI readiness
  'geo-bots': health(3, 'high', 'low'),
  'geo-nojs': health(2, 'high', 'high'),
  'geo-structured': health(2, 'medium', 'low'),
  'geo-questions': health(1, 'medium', 'medium', 'marketing'),

  // Website health: speed basics
  'spd-ttfb': health(2, 'medium', 'medium'),
  'spd-viewport': health(2, 'high', 'low'),
  'spd-compression': health(1, 'low', 'low'),
  'spd-html-size': health(1, 'low', 'high'),
  'spd-blocking-scripts': health(1, 'low', 'medium'),

  // Website health: Google PageSpeed (only when PAGESPEED_API_KEY is set)
  // spd-google-score is never ranked; its impact/effort are nominal.
  'spd-google-score': { ...health(3, 'high', 'medium'), rankable: false },
  'spd-lcp': health(2, 'high', 'medium'),
  'spd-cls': health(1, 'medium', 'medium'),
  'spd-tbt': health(1, 'medium', 'medium'),
};

export const CHECK_IDS = Object.keys(CHECKS) as CheckId[];

export const PAGESPEED_CHECK_IDS: readonly CheckId[] = ['spd-google-score', 'spd-lcp', 'spd-cls', 'spd-tbt'];
