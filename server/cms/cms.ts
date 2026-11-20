// CmsInfo for the report: platform detection, plus the WordPress analysis when detected.
import type { CheckResult, CmsInfo } from '../../shared/types.js';
import { detectPlatform } from './detect.js';
import { analyseWordPress } from './wordpress.js';
import type { WordPressDeps, WordPressHome } from './wordpress.js';
import { wordpressChecks } from './wpChecks.js';
import { WORDFENCE_ATTRIBUTION } from './wordfence.js';

export interface CmsResult {
  cms: CmsInfo;
  /** wp-* checks (empty unless WordPress). */
  checks: CheckResult[];
  /** e.g. the Wordfence attribution when its data was used. */
  attributions: string[];
}

export const analyseCms = async (home: WordPressHome, deps: WordPressDeps): Promise<CmsResult> => {
  const detected = detectPlatform(home);
  if (detected.platform !== 'wordpress') {
    return {
      cms: { platform: detected.platform, ...(detected.version ? { version: detected.version } : {}) },
      checks: [],
      attributions: [],
    };
  }
  const wordpress = await analyseWordPress(home, deps);
  return {
    cms: { platform: 'wordpress', wordpress },
    checks: wordpressChecks(wordpress),
    attributions: wordpress.vulnSource === 'wordfence' ? [WORDFENCE_ATTRIBUTION] : [],
  };
};
