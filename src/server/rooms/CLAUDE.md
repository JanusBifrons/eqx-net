# CLAUDE.md — src/server/rooms

`SectorRoom.ts` is at its size cap (`scripts/audit-god-files.mjs`). New code goes to an extension point: [god-file-extension-points](../../../docs/architecture/god-file-extension-points.md).

- **A new client→server message** is a `register<Feature>(host)` file in `features/` that registers through `parsedMessage` (zod parse + `MalformedMessageTracker` on failure), plus one row in `features/index.ts`. Never add `this.onMessage` to `SectorRoom.ts`.
- **Host interfaces stay narrow:** each feature declares the fields, getters and methods it reads (`Pick<>`, `() => value` getters for fields the room reassigns). Never pass the room or its whole type.
- **A feature that holds a resource** returns `{ dispose }`; the room runs every collected `dispose` in `onDispose`. There is no tick hook: periodic work uses `gameClock.every(ms, guarded(...))`, and a per-tick subsystem call stays at its ordered call site.
- **Test-only `test_*` handlers** go in `features/devTestMessages.ts`, gated on testMode or `EQX_ALLOW_DEV_OVERRIDES` (in `TestMessageHandlers`).
- **Schemas** live in `src/shared-types/` (message families in `messages/*.ts`, next to `ClientMessageSchema`); never inline in a feature or the room.
