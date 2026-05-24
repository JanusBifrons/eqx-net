/**
 * Phase 0a regression lock (plan: e2e-rebuild) — the diag-instrumentation trap.
 *
 * THE BUG: `isDiagEnabled()` returns `true` whenever `navigator.webdriver`
 * is set, which Playwright ALWAYS sets. So every E2E spec (and the future
 * netcode-health gate) runs the heavy per-frame diagnostic path
 * (`mirror_clone` JSON.stringify, worker FRAME_MARKERS, mirror_rebuild
 * bracket, 30k-entry ring) — measuring an instrumented build no real
 * player runs. There is no `?diag=0` escape hatch from the webdriver
 * branch.
 *
 * THE FIX: an explicit `?diag=0` kill-switch evaluated BEFORE the
 * webdriver branch, plus a `__resetDiagCache()` that clears BOTH cached
 * latches (`_diagEnabled` AND `_maxEntries`) so a gate / test can force
 * the production code path under WebDriver.
 *
 * Level: this is module-level predicate logic with two module-private
 * caches — a node unit test at exactly that level is faithful. Hermetic
 * per-case isolation via `vi.resetModules()` (fresh `_diagEnabled` /
 * `_maxEntries` per case) so the matrix fails ONLY on the real assertion,
 * never on cache bleed.
 *
 * RED today: the `{ webdriver:true, '?diag=0' }` cell returns `true`
 * (webdriver wins); the no-regression cell `{ webdriver:true, '' }` must
 * STAY `true` (proves the other 49 specs are byte-unaffected).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./ClientLogger');

async function freshModule(opts: { webdriver: boolean; search: string }): Promise<Mod> {
  vi.resetModules();
  vi.stubGlobal('navigator', { webdriver: opts.webdriver } as Navigator);
  vi.stubGlobal('window', { location: { search: opts.search } } as unknown as Window & typeof globalThis);
  return import('./ClientLogger');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('isDiagEnabled() — explicit ?diag=0 overrides the webdriver auto-diag', () => {
  // [webdriver, search, expectedEnabled, label]
  const matrix: Array<[boolean, string, boolean, string]> = [
    [false, '', false, 'no webdriver, no flag → off (normal player)'],
    [false, '?diag=0', false, 'no webdriver, ?diag=0 → off'],
    [false, '?diag=1', true, 'no webdriver, ?diag=1 → on (manual capture)'],
    [true, '', true, 'webdriver, no flag → ON (NO-REGRESSION: the other 49 specs)'],
    [true, '?diag=0', false, 'webdriver, ?diag=0 → OFF (THE FIX — RED today)'],
    [true, '?diag=1', true, 'webdriver, ?diag=1 → on'],
  ];

  for (const [webdriver, search, expected, label] of matrix) {
    it(`{ webdriver:${webdriver}, search:'${search}' } → ${expected}  (${label})`, async () => {
      const mod = await freshModule({ webdriver, search });
      expect(mod.isDiagEnabled()).toBe(expected);
    });
  }
});

describe('__resetDiagCache() — clears BOTH cached latches (hostile S3)', () => {
  it('re-evaluates _diagEnabled after the environment changes', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { webdriver: false } as Navigator);
    vi.stubGlobal('window', { location: { search: '?diag=1' } } as unknown as Window & typeof globalThis);
    const mod = await import('./ClientLogger');

    expect(mod.isDiagEnabled()).toBe(true); // latched on first read

    // Environment flips but the cache must still return the latched value.
    vi.stubGlobal('window', { location: { search: '?diag=0' } } as unknown as Window & typeof globalThis);
    expect(mod.isDiagEnabled()).toBe(true); // still cached

    mod.__resetDiagCache();
    expect(mod.isDiagEnabled()).toBe(false); // re-evaluated against the new env
  });

  it('clears the _maxEntries ring-size latch so the cap re-latches to the new mode', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { webdriver: true } as Navigator);
    // diag OFF via the new override → PROD ring cap (25000) must latch.
    // 2026-05-21: PROD cap bumped 8000 → 25000 for the replay-grade
    // ground-truth tag streams (Phase A of the replay-infra plan).
    vi.stubGlobal('window', { location: { search: '?diag=0' } } as unknown as Window & typeof globalThis);
    const mod = await import('./ClientLogger');
    mod.installWindowLogger();
    const w = globalThis.window as unknown as { __eqxLogs: unknown[] };

    expect(mod.isDiagEnabled()).toBe(false);
    for (let i = 0; i < 25050; i++) mod.logEvent('t', { i });
    expect(w.__eqxLogs.length).toBe(25000); // PROD cap latched (not 60000)

    // Flip to diag ON and reset → the cap latch must clear, not stay at 25000.
    vi.stubGlobal('window', { location: { search: '?diag=1' } } as unknown as Window & typeof globalThis);
    mod.__resetDiagCache();
    expect(mod.isDiagEnabled()).toBe(true);
    for (let i = 0; i < 200; i++) mod.logEvent('t', { i });
    expect(w.__eqxLogs.length).toBe(25200); // grew past 25000 ⇒ _maxEntries re-latched to DIAG
  });
});

describe('installWindowLogger() — __eqxDiagEnabled mirrors the resolved predicate', () => {
  it('exposes false under webdriver when ?diag=0 (the gate reads this)', async () => {
    const mod = await freshModule({ webdriver: true, search: '?diag=0' });
    mod.installWindowLogger();
    const w = globalThis.window as unknown as { __eqxDiagEnabled: boolean };
    expect(w.__eqxDiagEnabled).toBe(false);
  });
});

/**
 * Streaming auto-capture mode (`?autocapture=1`) — plan: streaming
 * auto-capture, Phase 1 (2026-05-21). Mirror of the `isDiagEnabled()`
 * matrix above. Streaming is opt-in only — `?autocapture=1` enables,
 * anything else disables. WebDriver does NOT auto-enable (unlike
 * `?diag` which auto-enables for E2E specs).
 */
describe('isAutoCaptureEnabled() — opt-in via ?autocapture=1, never auto-enabled', () => {
  const matrix: Array<[boolean, string, boolean, string]> = [
    [false, '', false, 'no webdriver, no flag → off (normal player)'],
    [false, '?autocapture=0', false, 'no webdriver, ?autocapture=0 → off'],
    [false, '?autocapture=1', true, 'no webdriver, ?autocapture=1 → ON (opt-in)'],
    [true, '', false, 'webdriver, no flag → off (E2E / netcode-gate measures production)'],
    [true, '?autocapture=0', false, 'webdriver, ?autocapture=0 → off'],
    [true, '?autocapture=1', true, 'webdriver, ?autocapture=1 → ON (test wants streaming)'],
  ];

  for (const [webdriver, search, expected, label] of matrix) {
    it(`{ webdriver:${webdriver}, search:'${search}' } → ${expected}  (${label})`, async () => {
      const mod = await freshModule({ webdriver, search });
      expect(mod.isAutoCaptureEnabled()).toBe(expected);
    });
  }
});

describe('installWindowLogger() — __eqxAutoCaptureEnabled mirrors isAutoCaptureEnabled()', () => {
  it('exposes false on normal sessions (the gate reads this)', async () => {
    const mod = await freshModule({ webdriver: true, search: '?diag=0' });
    mod.installWindowLogger();
    const w = globalThis.window as unknown as { __eqxAutoCaptureEnabled: boolean };
    expect(w.__eqxAutoCaptureEnabled).toBe(false);
  });

  it('exposes true when ?autocapture=1 is set', async () => {
    const mod = await freshModule({ webdriver: false, search: '?autocapture=1' });
    mod.installWindowLogger();
    const w = globalThis.window as unknown as { __eqxAutoCaptureEnabled: boolean };
    expect(w.__eqxAutoCaptureEnabled).toBe(true);
  });
});

describe('__resetDiagCache() — also clears the autocapture latch', () => {
  it('re-evaluates _autoCaptureEnabled after the environment changes', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { webdriver: false } as Navigator);
    vi.stubGlobal('window', { location: { search: '?autocapture=1' } } as unknown as Window & typeof globalThis);
    const mod = await import('./ClientLogger');

    expect(mod.isAutoCaptureEnabled()).toBe(true); // latched on first read

    vi.stubGlobal('window', { location: { search: '' } } as unknown as Window & typeof globalThis);
    expect(mod.isAutoCaptureEnabled()).toBe(true); // still cached

    mod.__resetDiagCache();
    expect(mod.isAutoCaptureEnabled()).toBe(false); // re-evaluated
  });
});
