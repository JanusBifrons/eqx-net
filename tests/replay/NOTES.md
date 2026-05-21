# `tests/replay/` — capture-driven replay test bed

Plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-zany-narwhal.md`
(capture-driven replay infrastructure, 2026-05-21).

## Why this exists

Past 5 days of attempted spiral fixes all shipped passing local tests
and broke on-device. Root cause: tests used `tests/scenarios/runner.ts`,
a re-implementation that omits ~80 % of real `ColyseusGameClient`. Any
bug in the omitted 80 % was uncatchable.

This directory's harness drives the REAL `ColyseusGameClient` through
a captured on-device session with `MockClock` + `MockKeyboard` +
`MockRoom`. Real production code paths execute end-to-end.

## File layout

```
tests/replay/
├── NOTES.md                            this file
├── captureLoader.ts                    parse diag/captures/<id>/
├── captureHarness.ts                   the driver — drives real ColyseusGameClient
├── captureHarness.test.ts              harness self-tests (smoke)
├── mockKeyboard.ts                     real keyboard.read() interface, captured-intent-driven
├── mockRoom.ts                         colyseus.js Room substitute (send + onMessage no-op)
├── ReplayTrace.ts                      output shape
├── userContracts.ts                    assertNoTeleport / assertInputFlow / etc.
├── userContracts.test.ts               assertion self-tests
└── captures/
    ├── vg9hon-idle.test.ts             lock against the 2026-05-20 idle capture
    └── ers7xy-active.test.ts           lock against the 2026-05-20 active capture
```

## Harness faithfulness (Phase E, 2026-05-21)

`replayCapture(...)` reproduces on-device `ticksAhead` to within ±1
tick on the two existing captures taken on the current code lineage
(`f59b9ac` ≡ `c3f3d8b` reverted-cap state):

| capture | on-device final ticksAhead | harness reproduces |
|---|---|---|
| `vg9hon` | 214 | 214 ✓ |
| `ers7xy` | 327 | 326 ✓ (Δ=1) |

This is the load-bearing faithfulness signal: the prediction state
machine in the REAL production code produces the same numbers given
the same snapshot stream the on-device client received. The harness
is therefore a faithful surrogate for the spiral-pathway.

The `lywvpj` capture (2026-05-21 cap-fix bug capture) is NOT used as
a lock yet because:
  1. It was taken on the buggy `6e4d9c2` (cap engaged) which is now
     reverted at `c3f3d8b`. The current production code (no cap)
     differs from the captured code's behaviour at the input loop.
  2. It predates Phase A's enriched capture format (no `input_intent`
     or `local_pose_rendered` events), so the rich user-contract
     assertions can't fully exercise it.

## What's NOT proven yet (Phase E gap, to address with fresh capture)

The "ground-truth match" — replaying a capture and asserting the
harness's reconstructed `local_pose_rendered` matches the captured
`local_pose_rendered` within tolerance — requires a capture taken on
the post-Phase-A code. Existing captures predate Phase A so they
lack the new tags.

Mitigation: any future smoke capture (the very next one) WILL be
Phase-A-enriched. The first such capture should be paired with a
`captures/<id>-groundtruth.test.ts` that adds the
`assertGroundTruthMatch` assertion, completing Phase E proper.

## Workflow (Phase F)

```
# 1. User takes a smoke test and submits diag/captures/<NEW_ID>/
# 2. Add a regression-lock test file:
#      cp tests/replay/captures/vg9hon-idle.test.ts \
#         tests/replay/captures/<short-id>.test.ts
#    Update:
#      - CAPTURE_PATH constant to the new dir
#      - ON_DEVICE_TICKS_AHEAD from the capture's summary.json `stats.ticksAhead`
#      - Test description in describe(...) to match the smoke symptom
# 3. Run the new lock:  pnpm vitest run tests/replay/captures/<short-id>.test.ts
#    Expected: faithfulness assertion PASS (within ±5 of on-device),
#              user-contract assertions FAIL on whatever the bug is
#    (teleport, input-flow violation, ticksAhead unbounded, etc.).
#    Each failure points at the FIRST observable issue with timestamp.
# 4. Fix-iterate against:
#      pnpm test tests/replay/        # all replay locks must pass
#      pnpm test                      # full unit suite stays green
# 5. ONE smoke handoff to confirm.
```

### Why no CLI tool?

The plan originally included `scripts/capture-to-test.mjs` for one-step
test-from-capture generation. That hit the `@core/*` alias chain — tsx
doesn't read vitest's `resolve.alias`, so any script that imports
`ColyseusClient.ts` (which uses `@core/...` extensively) can't run via
`pnpm tsx scripts/...`. The "copy-the-template" workflow above is one
extra minute and avoids the alias-handling complexity entirely. If you
really want a CLI later, the right shape is a vitest-runnable
diagnostic test that prints a report on stdout (since vitest IS the
only runtime that resolves `@core/*` correctly).
