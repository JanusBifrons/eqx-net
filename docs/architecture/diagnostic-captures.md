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

## Streaming auto-capture — manual `?autocapture=1` + account-gated default-on

There are two ways a capture lands on disk:

1. **Manual `POST /diag/capture`** — one snapshot of the ring, triggered from
   Settings → Capture Diagnostic (above).
2. **Streaming `POST /diag/capture/stream`** — `src/client/debug/streamingDiag.ts`
   flushes the ring every 2 s (plus a `sendBeacon` final flush on tab-close), so
   a capture is on disk *before* you hit Capture and survives a crash. Each
   streaming session is its own `diag/captures/<sessionId>/` directory.

**`?autocapture` vs `?diag` (they're independent).** `?diag` controls
*instrumentation depth* — it adds expensive per-frame markers and the
high-volume per-RAF tags (`rafTick`, `input_intent`, `local_pose_*`, `inputSent`)
to the ring, and is what the netgate deliberately turns *off* (it perturbs the
very corr/drift metrics you'd measure). `?autocapture` controls *continuous
streaming to disk*. **Autocapture WITHOUT diag is the preferred playtest mode:**
you get a capture for every session AND the metrics reflect the real,
uninstrumented code path (the ring still carries the production-parity signal —
`correction`, `snapshot` drift/rtt/corr, `raf_gap`, `longtask`, combat,
lifecycle).

**Account-gated default-on (2026-06-20).** Streaming is now DEFAULT-ON for the
accounts listed in `AUTOCAPTURE_ACCOUNT_EMAILS`
(`src/client/debug/ClientLogger.ts`) — no `?autocapture=1` needed — so the
playtest owner gets a capture every session with no manual step. Every other
player and ALL automation stay at zero cost. Precedence in
`isAutoCaptureEnabled()` (highest first):

1. `?autocapture=0` — explicit opt-out, wins over everything (the kill-switch).
2. `?autocapture=1` — explicit opt-in on any session/device (E2E streaming specs).
3. `navigator.webdriver` — automation never auto-streams via the account gate.
4. persisted account email ∈ `AUTOCAPTURE_ACCOUNT_EMAILS` → on.
5. otherwise off.

How the boot-time decision reads the email: `authStore.setAuth` persists the
logged-in email to `localStorage` (`auth/emailStorage.ts`), because
`installStreamingDiag()` runs at App module-load *before* auth resolves. A
returning logged-in pilot therefore resolves `true` at boot (streaming captures
even pre-game events); a fresh login activates mid-session via
`refreshAutoCaptureLatch()` (the App.tsx auth effect re-evaluates the latch once
`user.email` is known). To opt a new account in/out, edit
`AUTOCAPTURE_ACCOUNT_EMAILS`; emptying it reverts to pure `?autocapture=1`.

**Netgate interaction.** `tests/e2e/netcode-health.spec.ts` asserts
`__eqxAutoCaptureEnabled === false` on every rep. That holds under the account
gate because automation runs under `navigator.webdriver` (step 3 → false) and no
test logs in as a gated account — the gate never auto-streams during a
measurement.

## Related files

- `src/server/routes/diagRouter.ts` — capture handler, bucket routing, highlight extractor.
- `src/client/debug/streamingDiag.ts` — `?autocapture` streaming loop (account-gated default-on).
- `src/client/auth/emailStorage.ts` — persisted account email the autocapture gate reads at boot.
- `src/server/routes/diagRouter.test.ts` — directory layout + summary shape integration test.
- `src/client/debug/diagCapture.ts` — POST helper used by `SettingsModal.tsx`.
- `src/client/debug/ClientLogger.ts` — `window.__eqxLogs` ringbuffer.
- `src/server/debug/ServerEventLog.ts` — `getRecentEvents()` ringbuffer drained into the capture.
