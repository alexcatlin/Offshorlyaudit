// Spec 001: the client's fire-and-forget event call. fetch and window are stubbed; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; body: unknown }[] = [];
const keepalives: (boolean | undefined)[] = [];
let fail = false;

beforeEach(() => {
  calls.length = 0;
  keepalives.length = 0;
  fail = false;
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: { body?: string; keepalive?: boolean }) => {
      if (fail) throw new Error('blocked');
      keepalives.push(init.keepalive);
      calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
      return { status: 204, json: async () => null, headers: { get: () => null } };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const load = async () => import('../../src/api.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('track', () => {
  it('direct report: sends the event, placement and session only', async () => {
    const { setTrackContext, track } = await load();
    setTrackContext({ session: 'S'.repeat(22) });
    track('cta_click', 'ai-top');
    track('report_view');
    await flush();
    expect(calls).toEqual([
      { path: '/api/event', body: { event: 'cta_click', placement: 'ai-top', session: 'S'.repeat(22) } },
      { path: '/api/event', body: { event: 'report_view', session: 'S'.repeat(22) } },
    ]);
  });

  it('shared page: marks the click as shared, with no session', async () => {
    const { setTrackContext, track } = await load();
    setTrackContext({ shared: true });
    track('cta_click', 'audit-link');
    await flush();
    expect(calls).toEqual([{ path: '/api/event', body: { event: 'cta_click', placement: 'audit-link', shared: true } }]);
  });

  it('the event call survives a same-tab navigation (keepalive); other calls do not set it', async () => {
    const { setTrackContext, track, fetchShared } = await load();
    setTrackContext({ shared: true });
    track('cta_click', 'audit-link');
    await flush();
    expect(keepalives).toEqual([true]);
    keepalives.length = 0;
    await fetchShared('S'.repeat(22)).catch(() => undefined);
    expect(keepalives).toEqual([false]);
  });

  it('the email-used alert counts without any context', async () => {
    const { setTrackContext, track } = await load();
    setTrackContext(null);
    track('cta_click', 'blocked');
    await flush();
    expect(calls).toEqual([{ path: '/api/event', body: { event: 'cta_click', placement: 'blocked' } }]);
  });

  it('with no context a report click sends nothing', async () => {
    const { setTrackContext, track } = await load();
    setTrackContext(null);
    track('cta_click', 'ai');
    track('report_view');
    await flush();
    expect(calls).toEqual([]);
  });

  it('a blocked or failing call is silent', async () => {
    const { setTrackContext, track } = await load();
    setTrackContext({ session: 'S'.repeat(22) });
    fail = true;
    expect(() => track('cta_click', 'ai')).not.toThrow();
    await flush();
  });
});
