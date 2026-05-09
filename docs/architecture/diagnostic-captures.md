# Diagnostic captures

Each capture is a **directory** under `diag/captures/<ISO-timestamp>-<id>/`, written by the dev-only `POST /diag/capture` endpoint (`src/server/routes/diagRouter.ts`). The client triggers a capture from Settings → Capture Diagnostic; the body is the contents of `window.__eqxLogs` plus the latest `gameClient.stats`, basic environment info, and the wall-clock client-boot epoch.

The directory layout is purpose-grouped so future analysis starts with a small file and dives into one sibling for the answer — instead of grep-cycling a single 400 KB blob.

## Layout

```
diag/captures/<ts>-<id>/
  summary.json        ← read first
  perf.ndjson         ← server: tick_hitch, tick_budget, gc_pause
  corrections.ndjson  ← client: correction
  combat.ndjson       ← client: fire, fireRejected, swarm_near_enter/exit
                        server: fire_received
  lifecycle.ndjson    ← client: welcome, disconnected, room_error
                        server: player_join/leave/rebind/lingered, ownerless_evicted
  snapshots.ndjson    ← client: snapshot           (high vol — every tick of state)
                        server: snapshot_broadcast (high vol)
  raf.ndjson          ← client: rafTick, inputSent (highest vol — every frame)
                        server: input_received     (highest vol)
  other.ndjson        ← anything unmapped (defensive — empty under normal use)
```

Empty siblings are not written, so the directory tells you at a glance which signal categories actually fired.

## Where to look first

`summary.json` is small (typically 2–5 KB) and contains everything you need to choose a sibling:

- **`note`**, **`userAgent`**, **`viewport`** — what the user said, and what device.
- **`stats`** — last `gameClient.stats` snapshot (rttMs, driftUnits, rollingCorrRate, snapshotJitterMs, etc.).
- **`timing`** — first/last `ts` per source. Client `ts` is `performance.now()` (relative to client boot); server `ts` is wall-clock ms epoch. To align the two timelines, subtract `clientEpochMs` from any wall-clock reference.
- **`counts.tags`** — `source/tag` histogram. Spot-check whether the high-volume events look proportionate.
- **`counts.buckets`** — per-sibling line counts. Tells you which sibling is non-empty.
- **`highlights`** — extracted payloads, no skimming required:
  - `topTickHitches` (top 5 by `totalMs`)
  - `topTickBudgets` (top 3 by `totalMs`)
  - `gcPauses` (all — rare events)
  - `topCorrections` (top 5 by `driftUnits`)
  - `firstError` (first `room_error` or `disconnected`, or `null`)

If the highlights answer the question, you're done. If not, the histogram tells you which sibling to read next.

## Adding a new tag

1. Emit it from the client (`logEvent('new_tag', {...})`) or the server (`serverLogEvent('new_tag', {...})`).
2. Add **one line** to the `BUCKETS` map in `src/server/routes/diagRouter.ts`. That's the only routing surface — the writer, summary, and tests all read from it.

If a new tag is not in `BUCKETS` it lands in `other.ndjson` so nothing is silently lost; the routing line just promotes it to the right purpose-group.

## What's not in here

- The pre-redesign single-file captures (a flat `<ts>-<id>.json` blob with `logs`, `serverEvents`, `stats` at top level) are still readable as plain JSON if you happen to need an older one. They are not migrated.
- Cross-process correlation between client `performance.now()` and server `Date.now()` is exposed via `clientEpochMs` in the summary but no analysis tool is built on it yet — add one if a future regression needs aligned timelines across the two clocks.

## Related files

- `src/server/routes/diagRouter.ts` — capture handler, bucket routing, highlight extractor.
- `src/server/routes/diagRouter.test.ts` — directory layout + summary shape integration test.
- `src/client/debug/diagCapture.ts` — POST helper used by `SettingsModal.tsx`.
- `src/client/debug/ClientLogger.ts` — `window.__eqxLogs` ringbuffer.
- `src/server/debug/ServerEventLog.ts` — `getRecentEvents()` ringbuffer drained into the capture.
