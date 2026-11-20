import { describe, expect, it } from 'vitest';
import { aggregate, buildIndex, createWordfence, matchVersion, parseFeedStream, versionInRange } from '../../server/cms/wordfence.js';
import { fixture } from './_siteMock.js';

const feed = fixture('wordfence/scanner-feed.json');

/** Split a string into small chunks to exercise the streaming parser across boundaries. */
async function* chunked(s: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('wordfence', () => {
  it('stream-parses records across chunk boundaries (braces and quotes inside strings)', async () => {
    const seen: unknown[] = [];
    const n = await parseFeedStream(chunked(feed, 5), (v) => seen.push(v));
    expect(n).toBe(5);
    expect((seen[1] as { title: string }).title).toBe('Fixture issue B {with braces} and "quotes"');
  });

  it('also accepts a top-level array', async () => {
    const arr = `[${Object.values(JSON.parse(feed) as Record<string, unknown>).map((v) => JSON.stringify(v)).join(',')}]`;
    const { records } = await buildIndex(chunked(arr, 11));
    expect(records).toBe(4); // informational record skipped
  });

  it('range edges with inclusive and exclusive flags', () => {
    const r = { from: '3.17.0', fromInclusive: false, to: '3.18.0', toInclusive: true };
    expect(versionInRange('3.17.0', r)).toBe(false);
    expect(versionInRange('3.17.1', r)).toBe(true);
    expect(versionInRange('3.18.0', r)).toBe(true);
    expect(versionInRange('3.18.1', r)).toBe(false);
    const open = { from: '*', fromInclusive: true, to: '5.8.3', toInclusive: true };
    expect(versionInRange('0.1', open)).toBe(true);
    expect(versionInRange('5.8.3', open)).toBe(true);
    expect(versionInRange('5.8.4', open)).toBe(false);
    expect(versionInRange('garbage', open)).toBe(false);
    expect(versionInRange('6.4', { from: '6.4', fromInclusive: true, to: '6.4.2', toInclusive: true })).toBe(true);
  });

  it('matches by type and slug, aggregates count and highest severity', async () => {
    const { index } = await buildIndex(chunked(feed));
    expect(matchVersion(index, 'plugin', 'contact-form-7', '5.8.3')).toHaveLength(1);
    expect(matchVersion(index, 'plugin', 'contact-form-7', '5.8.4')).toHaveLength(0);
    // elementor 3.17.5: B (3.0.0 ≤ v < 3.18.0) and C (3.17.0 < v ≤ 3.18.0)
    const m = matchVersion(index, 'plugin', 'elementor', '3.17.5');
    expect(m).toHaveLength(2);
    expect(aggregate(m)).toEqual({ count: 2, highest: 'critical' });
    // 3.18.0: B excluded (to exclusive), C included
    expect(matchVersion(index, 'plugin', 'elementor', '3.18.0').map((e) => e.patched)).toEqual([false]);
    expect(matchVersion(index, 'core', 'wordpress', '6.4.2')).toHaveLength(1);
    expect(matchVersion(index, 'theme', 'elementor', '3.17.5')).toHaveLength(0);
    expect(matchVersion(index, 'plugin', 'elementor', null)).toHaveLength(0);
    expect(aggregate([])).toBeNull();
  });

  it('disabled without a key; ready only after a usable feed', async () => {
    expect(createWordfence(null)).toBeNull();
    expect(createWordfence({ apiKey: '' })).toBeNull();

    let auth = '';
    const wf = createWordfence({
      apiKey: 'test-key',
      fetchImpl: async (_u, init) => {
        auth = init.headers.authorization ?? '';
        return new Response(feed);
      },
    })!;
    expect(wf.ready).toBe(false);
    expect(wf.match('plugin', 'contact-form-7', '5.8.3')).toEqual([]);
    await expect(wf.refresh()).resolves.toBe(true);
    expect(auth).toBe('Bearer test-key');
    expect(wf.ready).toBe(true);
    expect(wf.match('plugin', 'contact-form-7', '5.8.3')).toHaveLength(1);

    const empty = createWordfence({ apiKey: 'k', fetchImpl: async () => new Response('{"errors":[]}') })!;
    await expect(empty.refresh()).resolves.toBe(false);
    expect(empty.ready).toBe(false);
    const denied = createWordfence({ apiKey: 'k', fetchImpl: async () => new Response('{}', { status: 401 }) })!;
    await expect(denied.refresh()).resolves.toBe(false);
  });
});
