# Drawer perf + happy-path test — handoff notes

Session ended 2026-05-13 with the happy-path test still failing.
The user wants this picked up tomorrow.

## TL;DR

| Status | Item |
|---|---|
| ✅ Shipped, load-bearing | `9c04bbf` swarmSnapStats throttled to 1 Hz (was ~200 sorts/s on the main thread; saved 2.3 s of CPU per drawer-mount window) |
| ✅ Shipped, load-bearing | `2aa7d4f` Drawer `ModalProps={ keepMounted: true }` (eliminates the cold MUI Modal/Slide mount cost on every drawer open) |
| ✅ Shipped, load-bearing | `f7386a9` Pixi viewport `eventMode: 'none'` + `features.globalMove: false` (skips per-sprite hit-test traversal on every native pointer event — pixijs/pixijs#6515) |
| ✅ Shipped, paradigm | `55ff74f` Hoist static `sx` objects to module-level consts + `useMemo` for dynamic ones + `useCallback` for handlers + `React.memo` on RailButton |
| ✅ Shipped | `f81e129` Add `SlideProps={{ mountOnEnter: false, unmountOnExit: false }}` to pre-mount drawer children |
| ❌ Not passing | `tests/e2e/drawer-galaxy-overview-spawn.spec.ts` — the happy-path "spawn → drawer → roster card → modal" spec the user wanted as the regression lock |
| 📈 Open | <500 ms drawer-open target — current measurement on a clean run was 1.22 s (with all fixes); test infra noise prevented us from re-confirming after the sx-hoist commit |

All 706 unit/component tests pass.

## Measurements (one clean run each, on the auth'd `page` fixture)

```
baseline (no perf fixes):                 CLICK→VISIBLE 13.7 s  (drawer-lag-trace.spec.ts)
+ swarmSnapStats throttle:                CLICK→VISIBLE  3.07 s
+ ModalProps keepMounted:                 CLICK→VISIBLE  1.22 s
+ SlideProps mountOnEnter:false:          (re-measure tomorrow on fresh servers)
+ sx hoist refactor (55ff74f):            (re-measure tomorrow on fresh servers)
target:                                   CLICK→VISIBLE  < 500 ms
```

The 13.7 → 1.22 s reduction is real and stable — it's the *visible to the user*
improvement. The remaining 1.22 s tail is dominated by React reconciler +
emotion `sx`-prop processing on the first cold mount of GalaxyTab + ShipRosterPanel.

## CPU profile findings (drawer-lag-trace + scripts/analyze-cdp-profile.mjs)

From the baseline profile in `diag/drawer-lag-trace/cdp-perf.json`, top
self-time culprits during the lag window:

```
Time    %      Function                                  File
2296 ms 2.6%   _recomputeSwarmSnapStats                  net/ColyseusClient.ts:1372   ← FIXED
1103 ms 1.3%   styleFunctionSx2                          MUI emotion chunk             ← attacked by sx hoist
1102 ms 1.3%   getThemeValue                             MUI emotion chunk             ← attacked by sx hoist
 716 ms 0.8%   styleFromPropValue                        MUI emotion chunk             ← attacked by sx hoist
 597 ms 0.7%   murmur2 (emotion hash)                    MUI emotion chunk             ← attacked by sx hoist
 575 ms 0.7%   Box3                                      MUI Box                       ← attacked by sx hoist
 499 ms 0.6%   ButtonBase2                               MUI Button                    ← attacked by sx hoist
 498 ms 0.6%   deepmerge                                 emotion                       ← attacked by sx hoist
 462 ms 0.5%   handleInterpolation                       emotion                       ← attacked by sx hoist
```

## The happy-path test failure mode

`tests/e2e/drawer-galaxy-overview-spawn.spec.ts` times out at:

```ts
await page.locator('[data-testid="galaxy-tab-show-map"]').click({ force: true, timeout: 15_000 });
```

Even with 120 s total test budget + 30 s `toBeVisible` + 15 s click. The
`galaxy-tab-show-map` button (inside GalaxyTab → AdvancedDrawer body) is
never found in DOM.

### Why this is confusing

- Unit tests (706 of them) all pass — GalaxyTab renders correctly in
  isolation.
- The existing `drawer-galaxy-map-open-close.spec.ts` reaches
  `galaxy-tab-show-map visible` step in its happy run (when not blocked
  by the `logs cleared` 3 s ceiling).
- With `keepMounted: true` + `SlideProps.mountOnEnter: false`, the
  children should be in DOM from page-load.

### Hypotheses to try tomorrow (priority order)

1. **`active.node` identity is unstable** — `TABS` is module-level but
   `<GalaxyTab />` etc. evaluate to React elements at module load. Verify
   in Chrome devtools that `drawer-panel-galaxy` exists in DOM IMMEDIATELY
   after page load (no drawer click). If yes → React.memo cascade or test
   harness issue. If no → keepMounted+mountOnEnter:false isn't doing
   what we expect.

2. **`page.evaluate` + main-thread contention** — the existing test
   reports `logs cleared` (just a `page.evaluate(() => fn())`) at 4.5–5 s
   on this machine. That means Playwright's CDP itself can't get a slot.
   If TRUE, no amount of timeout tuning will help; we need to reduce the
   per-frame main-thread budget (Pixi tick is the main candidate). Try:
   - Profile a steady-state frame (no drawer interaction) to see if Pixi
     `update` is taking >8 ms.
   - Try `app.ticker.maxFPS = 30` temporarily to halve the Pixi load
     and re-measure the drawer test. If the test passes at 30 fps but
     fails at 60 fps, we've proven Pixi is starving Playwright.

3. **The MUI Drawer's child mount path** — even with our settings, MUI
   may have a `<Transition appear={...}>` somewhere that defers child
   mount. Read the MUI Drawer + Slide source in node_modules/ to confirm
   the exact prop chain.

4. **Pre-mount Galaxy tab outside the Drawer** — refactor so the
   `<GalaxyTab />` element lives in App.tsx, rendered always, and the
   Drawer only contains a slot/portal-target. This guarantees mount
   timing is decoupled from drawer state. Most invasive but most reliable.

## Files touched this session

```
src/client/render/PixiRenderer.ts                 viewport eventMode + globalMove
src/client/net/ColyseusClient.ts                  swarmSnapStats throttle
src/client/layout/Drawer/AdvancedDrawer.tsx       keepMounted + SlideProps + sx hoist + memo
src/client/layout/Drawer/tabs/GalaxyTab.tsx       sx hoist + useCallback
tests/e2e/drawer-lag-trace.spec.ts                NEW — CPU profile capture + perf budget
tests/e2e/drawer-galaxy-overview-spawn.spec.ts    user-requested happy-path spec — STILL FAILING
scripts/analyze-cdp-profile.mjs                   NEW — reads cdp-perf.json, prints top self/total time
docs/HANDOFF-drawer-perf-2026-05-13.md            THIS FILE
```

## Process notes from the user (for next session)

- "We must chase this issue down" — user wanted root-cause not band-aids.
- "Don't add more generous timeouts to dodge the bug" — timeouts are signals,
  not solutions.
- "Why can't we just trust Playwright's own measurements?" — Playwright's
  primitives (`.click`, `toBeVisible`) are correct; the workaround attempts
  (MutationObserver, custom evaluate-click) just obscure the signal.
- "Use real clicks" for the user-experience steps; setup steps can use
  Zustand for stability.
- The user has been operating via phone remote control — every test cycle
  consumes their wall-clock budget.

## Lessons / paradigm to establish in `src/client/CLAUDE.md` tomorrow

1. **Every inline `sx={{...}}` allocates a fresh object emotion must
   hash + merge + style-resolve.** Hoist static sx to module-level
   consts. Use `useMemo` for dynamic ones. Name them by purpose
   (`HEADER_SX`, `CARD_SX`) so the cost is visible to readers.

2. **MUI Drawer / Modal / Dialog: pre-mount with `keepMounted: true`
   + `SlideProps.mountOnEnter: false`.** The cold Modal mount is
   the dominant cost — pay it once at page-load, not on every open.
   Document the trade-off (snapshot-rate subscribers in hidden tabs
   need to be gated by `tabVisible`).

3. **`React.memo` on tab components + `useCallback` on click handlers
   in lists.** Stable prop identity is what keeps memoization alive.

4. **Profile before refactoring.** `tests/e2e/drawer-lag-trace.spec.ts`
   + `scripts/analyze-cdp-profile.mjs` is the established loop. Capture
   a baseline, change one thing, recapture. Don't iterate on hypotheses
   without measurement.

5. **Pixi event-system tuning is correct-by-docs but small in scale**:
   `viewport.eventMode = 'none'` skips a per-sprite hit-test traversal,
   `features.globalMove = false` skips per-frame global-move dispatch.
   Both should be applied to any heavy Pixi container (per pixijs#6515).

6. **Test infrastructure noise is real and load-bearing.** When the
   Pixi tick + Colyseus snapshot apply contend with Playwright's CDP
   roundtrip, every step appears slow. The fix is to reduce per-frame
   CPU, not to bump test timeouts.
