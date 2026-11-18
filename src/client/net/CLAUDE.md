# CLAUDE.md — src/client/net

Rules for the client network layer. `ColyseusClient.ts` is at its size cap (`scripts/audit-god-files.mjs`); where each kind of addition goes: [god-file-extension-points](../../../docs/architecture/god-file-extension-points.md).

- **A new server → client message** is four pieces: its zod schema in its `src/shared-types/messages/` family file, a row in `ServerMessageSchemas` (`src/shared-types/messages.ts`), a handler in a `handlers/<feature>Handlers.ts` file (`register<Feature>Handlers(room, ctx)`), and one call in `handlers/index.ts`. Never add an inline `room.onMessage` to `ColyseusClient.ts`.
- **Handler ctx interfaces stay narrow:** only what those handlers touch (mirror, callbacks, store writers), never the whole `ColyseusClient`.
- **Handlers allocate nothing new per message** (#14): closures and scratch are created once at registration.
- **A per-entity timer or state machine is its own module** (like `drawnShellTiming.ts`, `damageNumberTargets.ts`), never inline in `ColyseusClient.ts`.
- **Never add a `ColyseusClient` field for one feature;** the feature's module owns its state.
- **A per-frame mirror pass** is a function in `mirror/` taking the once-built `MirrorPassCtx` (getters for reassigned fields), called in order from `updateMirror`.
- **`snapshot` and `swarm` stay inline in `connect()`** (hot path).
- **Fire control and lock state** live in `FireControlClient.ts` (lock line in `fireControl/`); `ColyseusClient` keeps one-line delegates and reaches prediction/fire dispatch for it through `FireControlHost`.
