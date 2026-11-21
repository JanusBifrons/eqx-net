# CLAUDE.md — src/client/net

Rules for the client network layer. `ColyseusClient.ts` is at its size cap (`scripts/audit-god-files.mjs`); where each kind of addition goes: [god-file-extension-points](../../../docs/architecture/god-file-extension-points.md).

- **A new server → client message** is four pieces: its zod schema in its `src/shared-types/messages/` family file, a row in `ServerMessageSchemas` (`src/shared-types/messages.ts`), a handler in `handlers/<feature>Handlers.ts`, and one call in `handlers/index.ts`. Never add an inline `room.onMessage` to `ColyseusClient.ts`.
- **Handler ctx interfaces stay narrow:** only what the handlers touch, never the whole `ColyseusClient`.
- **Handlers allocate nothing new per message** (#14): closures and scratch are created once at registration.
- **A per-entity timer or state machine is its own module** (like `drawnShellTiming.ts`, `damageNumberTargets.ts`), never inline in `ColyseusClient.ts`.
- **Never add a `ColyseusClient` field for one feature;** the feature's module owns its state.
- **A per-frame mirror pass** is a function in `mirror/` taking the once-built `MirrorPassCtx` (getters for reassigned fields), called in order from `updateMirror`.
- **A prediction-step pass** is a function in `prediction/` taking the once-built `PredictionStepCtx`, called in order from `tickPhysics`.
- **Per-sector state** is reset in `prediction/resetPrediction.ts`; **join / transport / room lifecycle** lives in `connection/roomConnection.ts`; **teardown** (`dispose`) in `connection/clientTeardown.ts` — a new subsystem is disposed there.
- **An outbound room command** (`room.send` from a public client method) is a function in `connection/roomCommands.ts` taking the once-built `RoomCommandsCtx`; `ColyseusClient` keeps a one-line delegate.
- **PredWorld body sync** (local, swarm, remote bodies) lives in `prediction/predWorldSync.ts`.
- **`snapshot` and `swarm` stay inline in `connect()`** (hot path).
- **Fire control and lock state** live in `FireControlClient.ts` (lock line in `fireControl/`); `ColyseusClient` keeps one-line delegates, reached through `FireControlHost`.
- **The teleport bound** (`isImplausibleJump`, `TELEPORT_MAX_PLAUSIBLE_SPEED`, `TELEPORT_FLOOR_U`): one home, `plausibleSpeed.ts`; every interpolator that snaps imports it, never redefines it.
- **Display-delay slew + stall hold:** one home, `displayDelayHold.ts`, one record per stream; never copy it (modes: `swarmDelayMode.ts`).
- **The local ship's own fire** (`sendFire`, the live beam) lives in `fireControl/LocalFireClient.ts`; **damage and death** (`handleDamage`, `killEntity`, ...) in `damagePath.ts`. Each takes a host/ctx built once in `ColyseusClient`.
- **Judge a playtest's network** with `pnpm phone:verdict`: [network-quality](../../../docs/ops/network-quality.md).
