/**
 * Regression lock (2026-11-14 playtest): streaming auto-capture silently
 * stopped after a dev-server restart and never resumed in that tab.
 *
 * Level: `streamingDiag.ts` is module-level timer + fetch + beacon state —
 * a node unit test with fake timers, a mocked fetch and a stubbed
 * `document`/`navigator` is faithful. Fresh module per case.
 *
 * Mechanisms locked:
 *   1. ONE 404 (backend answering mid-restart, or a proxy blip)
 *      permanently disabled streaming for the tab (old fail-stop).
 *   2. A fetch that never settles (backend dies holding the socket)
 *      left the one-in-flight lock `_inFlight` true forever.
 *   3. `_flushedFinal` latched on the first hide; a later hide (after
 *      the tab came back) sent no final beacon.
 * And the genuine production fail-stop (endpoint not mounted) still
 * engages: consecutive 404s spanning > 30 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

interface Env {
  fetchMock: ReturnType<typeof vi.fn>;
  beacon: ReturnType<typeof vi.fn>;
  doc: { visibilityState: string; fire: (s: string) => void };
  logEvent: (tag: string, data: Record<string, unknown>) => void;
}

async function setup(): Promise<Env> {
  vi.resetModules();
  const docListeners: Record<string, Listener[]> = {};
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t: string, f: Listener): void => {
      (docListeners[t] ??= []).push(f);
    },
    fire(s: string): void {
      doc.visibilityState = s;
      for (const f of docListeners['visibilitychange'] ?? []) f();
    },
  };
  const beacon = vi.fn(() => true);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { webdriver: false, userAgent: 'test', sendBeacon: beacon });
  vi.stubGlobal('window', {
    location: { search: '?autocapture=1' },
    innerWidth: 1,
    innerHeight: 1,
    addEventListener: (): void => {},
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const logger = await import('./ClientLogger.js');
  const mod = await import('./streamingDiag.js');
  mod.installStreamingDiag();
  return { fetchMock, beacon, doc, logEvent: logger.logEvent };
}

const ok = (): Response => ({ status: 200, ok: true }) as Response;
const notFound = (): Response => ({ status: 404, ok: false }) as Response;

async function tick(env: Env, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    env.logEvent('probe', { i });
    await vi.advanceTimersByTimeAsync(2_000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('streamingDiag survives a dev-server restart + tab hide/show', () => {
  it('a 404 during a restart window does not permanently stop streaming', async () => {
    const env = await setup();
    env.fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound()).mockResolvedValue(ok());
    await tick(env, 2); // two 404s while the backend restarts
    await tick(env, 2); // backend back
    expect(env.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a hung fetch does not wedge the in-flight lock forever', async () => {
    const env = await setup();
    env.fetchMock.mockImplementationOnce(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    env.fetchMock.mockResolvedValue(ok());
    await tick(env, 1); // hangs
    await tick(env, 10); // 20 s later
    expect(env.fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('a second hide after the tab came back sends another final beacon', async () => {
    const env = await setup();
    env.fetchMock.mockResolvedValue(ok());
    env.logEvent('a', {});
    env.doc.fire('hidden');
    env.doc.fire('visible');
    env.logEvent('b', {});
    env.doc.fire('hidden');
    expect(env.beacon).toHaveBeenCalledTimes(2);
  });

  it('streaming continues (fetch) after a hide/show cycle', async () => {
    const env = await setup();
    env.fetchMock.mockResolvedValue(ok());
    env.logEvent('a', {});
    env.doc.fire('hidden');
    env.doc.fire('visible');
    await tick(env, 2);
    expect(env.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('production fail-stop: consecutive 404s spanning > 30 s disable streaming', async () => {
    const env = await setup();
    env.fetchMock.mockResolvedValue(notFound());
    await tick(env, 20); // 40 s of 404s
    const calls = env.fetchMock.mock.calls.length;
    await tick(env, 5);
    expect(env.fetchMock.mock.calls.length).toBe(calls);
  });
});
