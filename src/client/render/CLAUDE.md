# Render zone rules (PixiRenderer extension points)

`PixiRenderer.ts` is a god file under a size ratchet (`scripts/audit-god-files.mjs`): it may only shrink. New render code goes to an extension point, never inline. Full map: [god-file-extension-points](../../../docs/architecture/god-file-extension-points.md).

- **New per-frame visual** → an updater module in `pixi/` (`update<X>(mirror, ctx)`, like `pixi/shipSpriteUpdater.ts` or `pixi/beamUpdater.ts`). Its ctx is pooled: built once (in `init`, or at construction if a reset or probe reads it earlier), holding the pools, slot caches and scratch; the caller writes only per-frame scalars (camera scale, gates) before the call. PixiRenderer gains one call line plus one ctx field.
- **Per-frame path allocates nothing** (invariant #14): reuse pooled slots and scratch held by the ctx; no closures, arrays or object literals per frame.
- **New test / perf probe** (read only by DEV hooks, e2e or the perf harness) → a function in `pixi/rendererProbes.ts` taking `RendererProbeState`; PixiRenderer keeps a one-line public delegate. A new field the probe reads joins the `probeState()` getter view.
- **New init step** (scene layer, fx system, ctx wiring) → a function in `pixi/rendererSetup/` taking narrow deps and returning what it built; `init` assigns it.
- **Input / selection / camera framing** → `pixi/rendererInputController.ts` (+ base `rendererCommandRouting.ts`) and `pixi/cameraDirector.ts`, never PixiRenderer.
- **Never** add a new inline pass, or a field in PixiRenderer that serves one feature: the field belongs in that feature's ctx.
- Moves out of PixiRenderer are verbatim (behaviour identical) and lower its cap in `scripts/audit-god-files.mjs` in the same PR; never raise a cap or trim comments to fit.
- A new file stays ≤ 600 LOC.
