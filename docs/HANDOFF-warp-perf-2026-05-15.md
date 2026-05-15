# HANDOFF — warp-spool lag (open) — 2026-05-15

End-of-session record. The warp **visual/position** bugs are fixed and
shipped; the only open item is the **spool-window frame cost**. The
user explicitly deferred it ("[No preference]" on the approach, calling
it a night) — do NOT blind-fix it; isolate first.

## What is DONE (shipped, green, test-locked)

- **Teleport on first input after join/transit** — server idle-suppression
  starved just-joined stationary clients. Fix: `JOIN_BROADCAST_GRACE_TICKS`
  (5 s force-broadcast window) in `SectorRoom`. Locked by
  `tests/integration/sectorRoom/joinBroadcastGrace.test.ts`.
- **Galaxy map invisible in worker renderer** — `GalaxyMapLayer` now hosted
  in the renderer worker with a custom hit-test. (E2E `galaxy-map-toggle`
  was dropped — flaked on post-warp page-busy; covered by typecheck +
  units + the `galaxy_map_toggle` diagnostic event.)
- **Warp centre wrong** — three iterations, final state correct:
  1. `× resolution` (HiDPI theory) — WRONG, reverted. On-device evidence:
     sandbox screen-centre warp was pixel-exact on the DPR-3 phone with
     no scaling. Do not re-add.
  2. Game→Pixi **Y flip** missing on the world anchor (ripple at the
     ship's vertical mirror; off-screen at non-zero spawn Y).
  3. Anchor captured **once** at spool-start → froze while the ship flew
     ~539 u during the 3.6 s spool. Final fix: `{kind:'entity',entityId}`
     anchor the renderer re-resolves to the live sprite EVERY frame.
     Id-agnostic (local/remote/bot — no special-case, per the user's
     architectural correction). `{kind:'world'}` now only = "fixed point,
     no live entity" (remote warp-out, ship despawned).
  All locked by `src/client/render/PixiRenderer.warpCenter.test.ts`.
- **Grid-cell readout** — labels were only at macro (2500 u) intersections
  so the ÷500 HUD readout never landed on a labelled line. Now a label at
  every micro (500 u) intersection + micro grid alpha 0.18→0.34. Pure
  `computeGridLabels` locked by `BackgroundGrid.labels.test.ts`.

Verification at handoff: `pnpm typecheck` clean, `pnpm lint` 0 errors,
`pnpm test` **796/796**.

## OPEN — warp-spool lag

User: "I got a bit of lag as well". Evidence from diagnostic
`diag/captures/2026-05-15T22-08-40-272Z-s3b9l8`:

- 4 `raf_gap`s (116–183 ms) — ALL at the transit room-swap boundary
  (ts 20321, 20532, 20869, 25961). Transient handoff cost, not steady.
- ~29 ms mean frame confined to the spool window (ts 16895–20492) —
  exactly when the fullscreen filter chain (stacked `ShockwaveFilter`
  ×N + `ZoomBlurFilter` + `BloomFilter`) is active on a DPR≈2.6 mobile
  GPU. The every-micro-cell grid labels added the same day
  (`computeGridLabels`, O(n²) `Text` over the padded window) plausibly
  compound it.

**Cannot attribute filters-vs-labels from this capture.** Three
candidate next steps (presented to the user; they had no preference):

1. **Isolate first (recommended).** Add a one-frame perf marker logging
   filter-pass time vs label-rebuild time separately; one short warp;
   the next capture says which dominates. No blind change.
2. **Lighten warp on mobile.** Fewer Shockwave layers + lower Bloom
   quality + ~30 % shorter spool on coarse-pointer devices. Likely the
   bigger cost but unverified.
3. **Pool grid-label `Text`.** Reuse instead of create/destroy on pan —
   removes the O(n²) churn regression regardless of whether it's the
   main cause. Safe hygiene even if not the dominant cost.

Recommended order: 1 → then 2 and/or 3 based on what 1 shows. Follow
Invariant #13 (failing/measuring test first) and the
"on-device-evidence over theory" lesson — get the isolating capture
before changing the filter chain.

## Pointers

- Warp centre resolver: `resolveWarpFilterCenter` in
  `src/client/render/PixiRenderer.ts` (pure, exported, tested).
- Anchor wiring: `src/client/App.tsx` (transit-spool + arrival effects).
- Grid labels: `computeGridLabels` in `src/client/render/BackgroundGrid.ts`.
- Full lesson + the debugging-discipline note: `docs/LESSONS.md`
  2026-05-15 entries (three of them).
