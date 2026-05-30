/**
 * Test-mode-only heap-leak injector for the mobile-perf gate.
 *
 * When the page is loaded with `?injectLeak=N` (N = bytes to retain per
 * RAF tick), this module installs a `requestAnimationFrame` callback
 * that pushes a `new Uint8Array(N)` onto `window.__testLeak` every
 * frame. The retained-array list is what makes the bytes survive GC,
 * so the mobile-perf gate's `jsHeapGrowthMb` metric trips reliably.
 *
 * Hard-gated:
 *   - `import.meta.env.DEV` (Vite tree-shakes out of prod bundles)
 *   - AND `?injectLeak=N` URL param (no opt-in ⇒ no allocation)
 *
 * Companion: the server's `SectorRoom.JoinOptionsSchema.injectLeak`
 * gate exists only for parity with the other test primitives
 * (`initialHull`, `initialShield`, `testTimeScale`); the server NEVER
 * reads this value back (the client trusts its own URL because the
 * hook itself is DEV-gated). No wire-format / `@type` schema change.
 *
 * Used by `tests/mobile-perf/heap-budget-injected-leak.spec.ts`. The
 * spec asserts that the gate's `jsHeapGrowthMb` metric DETECTS the
 * leak — if this hook ever stops allocating, the spec turns green and
 * CI alerts via the regression-lock contradiction (the gate has
 * stopped working).
 */

interface TestLeakWindow {
  __testLeak?: Uint8Array[];
}

/**
 * Install the leak injector. Idempotent — second call is a no-op.
 *
 * Call from `App.tsx` module-top-level alongside `installWindowLogger`.
 */
export function installTestLeakHook(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;

  const urlParams = new URLSearchParams(window.location.search);
  const rawParam = urlParams.get('injectLeak');
  if (rawParam === null) return;

  const bytesPerTick = parseInt(rawParam, 10);
  if (!Number.isFinite(bytesPerTick) || bytesPerTick <= 0) return;

  // Cap at 10 MB / tick to keep a misconfigured spec from blowing
  // through the absolute heap ceiling on the first frame. The
  // mobile-perf regression-lock spec uses 100 KB / tick (see
  // mobilePerfBudget.ts for the rationale).
  const safeBytes = Math.min(bytesPerTick, 10_000_000);

  const w = window as Window & TestLeakWindow;
  if (Array.isArray(w.__testLeak)) return;
  w.__testLeak = [];

  const tick = (): void => {
    w.__testLeak!.push(new Uint8Array(safeBytes));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // eslint-disable-next-line no-console
  console.warn(
    `[testLeakHook] injecting ${safeBytes} bytes per RAF tick — DEV+URL gated, prod-safe`,
  );
}
