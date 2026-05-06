# Ship Kinds

EQX Peri ships come in **kinds** — distinct hulls with their own physics, AI tuning, and silhouette. The catalogue lives at [src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts) and is the single source of truth for everything that needs to know about a kind: server-side spawn validation, physics tuning, AI behaviour, drone variety, and client-side picker / renderer.

## v1 catalogue

| Kind | Character | Top speed (boosted) | Yaw rate | Hull | Coast 2s |
|---|---|---|---|---|---|
| **Fighter** (default) | Balanced all-rounder | 1604 u/s | 2.0 rad/s (115°/s) | 100 | 55% retained |
| **Scout** | Light, fast, twitchy. Glass cannon. | 1444 u/s | 3.0 rad/s (172°/s) | 60 | 37% retained |
| **Heavy** | Sluggish accel, brutal top speed, heavy hull | 1802 u/s | 1.4 rad/s (80°/s) | 180 | 67% retained |

Numbers derive from the steady-state formula `v_terminal = thrustImpulse · boost / (1 − e^(−damping/60))` at the fixed 60 Hz step. See [docs/architecture/ship-physics-handling.md](../architecture/ship-physics-handling.md) for the full model.

## Picker UI

The bottom-right of the galaxy-map screen has a tile showing the currently-selected ship's silhouette + name. Clicking opens an MUI dialog with one card per kind, showing the silhouette, description, and stat chips (`Top` / `Turn` / `Hull`). Click a card — selection saves and the modal closes.

The trigger is **disabled while the local player has a ship in the world** (`useUIStore(s => s.shipCount > 0)`). The tooltip explains: "Currently flying — return to galaxy to switch ships". This means the modal cannot open mid-flight, so there's no need for a hot-swap path on the server.

## Persistence

The selection is per-authenticated-user, keyed `eqxShipSelection:<userId>` in `localStorage` (or `:anon` when logged out). [src/client/settings/userPrefs.ts](../../src/client/settings/userPrefs.ts) is the shared per-user storage helper; [src/client/settings/shipSelectionStorage.ts](../../src/client/settings/shipSelectionStorage.ts) is the per-pref module wrapping it.

`eqxSettings` was migrated to the same convention en route. The migration is **read-only on the legacy global key** so older tabs keep working — see [src/client/settings/userPrefs.ts](../../src/client/settings/userPrefs.ts) `oneShotMigrateLegacy`.

## Drones inherit the catalogue

Each AI drone picks a **random ship kind on spawn** ([src/server/spawn/SwarmSpawner.ts](../../src/server/spawn/SwarmSpawner.ts) `spawnDrone`). The chosen kind drives:

- The drone's collider radius (from `kind.radius`)
- The drone's hull (from `kind.maxHealth`)
- The AI behaviour's `thrust / turnKp / maxTorque` (from `kind.ai.*`)
- The drone's silhouette + colour on the client renderer

Distribution is uniform random; override with `SpawnerHooks.pickDroneKind` for biased mixes (e.g. 60/30/10). Drone bodies still use `spawnObstacle` (damping=0, no lateral grip) — they don't share the player car-physics model.

## Adding a new kind

Add one record to `SHIP_KINDS` in [src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts). No other code changes needed: the picker UI, server validation, drone spawner, and renderer all iterate `SHIP_KINDS_LIST` automatically.

```ts
export const SHIP_KINDS = Object.freeze({
  fighter: FIGHTER,
  scout: SCOUT,
  heavy: HEAVY,
  corvette: CORVETTE,  // ← new
});
```

**Append-only.** The swarm wire format encodes drone kinds as a `u8` index into `SHIP_KINDS_LIST` ([src/shared-types/swarmWireFormat.ts](../../src/shared-types/swarmWireFormat.ts) `SWARM_REC_SHIP_KIND_OFF`). Reordering the catalogue invalidates the index for any in-flight v2 packet — the test at [tests/unit/shipKinds.test.ts](../../tests/unit/shipKinds.test.ts) `catalogue order is fighter -> scout -> heavy (wire-format-stable)` pins this.

When you genuinely need to remove a kind, bump `SWARM_WIRE_VERSION` and the renderer's fallback path takes over for any client still on the old version.

## Wire / schema surfaces

- **Player ships** — `ShipState.kind` on the Colyseus schema ([src/server/rooms/schema/SectorState.ts](../../src/server/rooms/schema/SectorState.ts)). Threaded from `JoinOptions.shipKind` ([src/server/rooms/SectorRoom.ts](../../src/server/rooms/SectorRoom.ts) `onJoin`) into the `SPAWN` worker command and into `physics.spawnShip(id, x, y, kindId)`. Validated with `isShipKindId`; unknown values fall back to `DEFAULT_SHIP_KIND`. Limbo / rebind paths **deliberately ignore** `JoinOptions.shipKind` so a bad-actor client can't mid-session swap kind.
- **Drones** — `shipKind` on the `SwarmEntityRecord`. Encoded as a `u8` index in the v2 swarm wire format. Decoded on the client into `SwarmRenderState.shipKind` for the renderer.

## Tests

- [tests/unit/shipKinds.test.ts](../../tests/unit/shipKinds.test.ts) — catalogue invariants, schema validation, archetype ordering.
- [src/client/settings/shipSelectionStorage.test.ts](../../src/client/settings/shipSelectionStorage.test.ts) — per-user storage round-trips, malformed-JSON fallback, quota-exceeded survival.
- [src/client/settings/settingsStorage.test.ts](../../src/client/settings/settingsStorage.test.ts) — `eqxSettings` per-user migration, legacy-key-read-only.
- [src/core/physics/ShipKindPhysics.test.ts](../../src/core/physics/ShipKindPhysics.test.ts) — top-speed and turn-rate ordering at runtime.
- [tests/e2e/ship-selection.spec.ts](../../tests/e2e/ship-selection.spec.ts) — picker UX flow with auth mock + reload-persistence.
