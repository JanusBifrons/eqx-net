# Weapon Mounts and Turret AI — Architecture

Shipped across Phases 0–4c of the multi-mount/turret refactor (2026-05-11). This document is the canonical walkthrough; the [phased plan file](../../.claude/plans/i-d-like-you-to-lexical-pony.md) records the intent and the order of arrival, [LESSONS.md](../LESSONS.md) records what hurt, and the per-zone CLAUDE.md files enforce the contracts at code-review time.

## Why this exists

Pre-refactor combat had exactly one fire origin per ship (`ship.pos + 20u * forward(ship.angle)`) and exactly one weapon active at a time. To support multi-mount ships (twin-cannon interceptors, fore-and-aft gunships) and the "pilot drives, turrets aim" model, every layer needed extending without regressing the legacy single-mount path.

Two non-negotiable design rules dropped out of the plan-agent review:

1. **One ownership site per state surface.** Mount-angle state is owned by `WeaponMountController.tickSlot` and **only** by that path. The drone AI calls it. The server's player update calls it. The client's prediction calls it. No second path may set mount angles or two correction paths will fight (the "chapter 2 lockstep" pattern from `docs/architecture/ai-lockstep.md`).
2. **The binary swarm wire stays at v3.** Mount-angle state never enters the per-tick binary swarm packet — it flows through the 20 Hz JSON `SnapshotMessage`, per-recipient, with delta-gating + quantisation so legacy single-mount kinds add zero bytes.

## Data model

### Catalogue ([src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts))

`ShipKindSchema` gained two optional, correlated fields:

```typescript
mounts?: ReadonlyArray<WeaponMount>;
slots?: ReadonlyArray<WeaponSlot>;
```

`WeaponMount` is a physical hardpoint: `{ id, localX, localY, baseAngle, arcMin, arcMax, rotationSpeed, weaponId }`. `WeaponSlot` is a logical group: `{ id, displayName, mountIds[] }`. The pilot selects an *active slot*; only mounts in the active slot run target-pick AI, rotate, and fire.

Schema validation (`.superRefine` block) enforces: mounts + slots present-or-both-absent; ids unique within kind; every `slot.mountIds[]` references a real mount; every mount belongs to exactly one slot.

**Backfilling rule for any new kind that doesn't have rotating turrets**: define a single mount `{ id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' }` and a single slot `{ id: 'primary', displayName: 'Primary', mountIds: ['forward'] }`. Legacy fighter/scout/heavy follow this pattern via the shared `LEGACY_FORWARD_MOUNT` / `LEGACY_PRIMARY_SLOT` constants.

Catalogue order is wire-format-stable (drone kinds encode as a `u8` index into `SHIP_KINDS_LIST`). Today the order is locked at `[fighter, scout, heavy, interceptor, gunship]`.

### Dynamic weapon mounts — latent slots (Phase 4 WS-B3, plan: effervescent-umbrella)

`ShipKindSchema` gained a third optional field:

```typescript
latentMounts?: ReadonlyArray<WeaponMount>;
```

A **latent mount** is a candidate hardpoint that is INACTIVE by default — full geometry (`localX/Y`, `baseAngle`, `arcMin/arcMax`, `rotationSpeed`) + a default `weaponId`, but it does not aim, fire, or render until **activated** by a per-instance ship upgrade. The fighter declares two latent wing hardpoints (`latent-wing-l`/`latent-wing-r`). A latent id must be unique within the kind AND distinct from every base mount id (enforced by `ShipKindSchema`'s `.superRefine`), so the per-instance index space never collides.

Adding the field is an **append-only record-shape change** (invariant #11 — the `SHIP_KINDS_LIST` indices are unchanged), so `SHIP_KIND_CATALOGUE_VERSION` is bumped (11 → 12) in the same PR. **No `SWARM_WIRE_VERSION` bump** — activated-mount state rides the player `ShipState`/roster, NOT the drone binary core.

**Activation is per ship INSTANCE.** A ship-level upgrade `activate_mount { shipId, slotId, weaponId }` activates the next latent slot and binds the player's chosen weapon. The activated `{ slotId, weaponId }` is persisted in the roster `mounts` JSON (`PlayerShipStore.ActivatedMount[]`) — switching ships switches the loadout (D8). The server validates ownership + that `slotId` is a real latent hardpoint (`isLatentSlot`) + that it isn't already on; a foreign / unknown / non-latent / duplicate request is a silent no-op. The echo is `mount_activated { shipInstanceId, mounts }`.

**The per-instance mount list is the lockstep seam.** Three pure resolvers in [`src/shared-types/shipKinds/slots.ts`](../../src/shared-types/shipKinds/slots.ts) are the ONE place the activated-slot → geometry mapping lives (the same trick as scrap colliders — geometry by `(kind, slotId)`, never on the wire):

- `resolveActivatedMounts(kind, activated)` → the activated latent hardpoints as `WeaponMount`s (catalogue geometry, the player's `weaponId` overriding the latent default; iterates the catalogue latent list for a stable order so a differently-ordered roster JSON can't desync).
- `resolveInstanceMounts(kind, activated)` → `[...kind.mounts, ...activated]` — the `mountAngles[]` INDEX SPACE (base mounts keep their catalogue indices, activated append). Un-upgraded ⇒ the base mount reference (byte-identical).
- `resolveInstanceFireMounts(kind, activated, slotId)` → `[...resolveSlotMounts(kind, slotId), ...activated]` — the FIRING set (active slot + every activated latent; activated mounts always fire).

The server aim ticker (`WeaponMountTicker.tickPlayer`) sizes the angle array by the FULL instance list and aims only the firing subset (non-firing instance mounts slew to base); the server fire resolver (`PlayerFireResolver`) resolves the firing set + reads each firing mount's slewed angle by its index in the full instance list. The client's `tickLocalMountAim` / `localShipMounts` / `updateLiveBeam` / `sendFire` use the SAME resolvers, so the predicted aim + beam + ghosts match the authoritative mount angles (lockstep, invariant #12). The activated mounts ride the PUBLIC `SnapshotMessage.states[].mounts` slice (emit-when-non-empty, for active AND lingering hulls) so other players see the extra turrets; `mountAngles[]` (already variable-length) carries their slewed angles with no wire bump. The renderer (`shipSpriteUpdater` → `MountVisualManager.ensureForInstance`) draws the extra barrels from `resolveInstanceMounts`, rebuilding the turret cluster when the activated set changes (`mountSig`). The UI is the `UpgradeModal`'s "Weapon mounts" section.

### Pure controller ([src/core/ai/WeaponMountController.ts](../../src/core/ai/WeaponMountController.ts))

Zero zone awareness, zero side effects. Same inputs → same outputs on server and client, which is the architectural foundation of lockstep.

```typescript
pickTarget(shipX, shipY, targets, prevTargetId, isHostile, { maxDistance?, stickyHysteresisFactor? })
  => MountTargetView | null

rotateMountToward(currentMountAngle, desiredBearing, mount, dtSec) => number
```

**Sticky hysteresis** (`STICKY_HYSTERESIS_FACTOR = 1.1`): the previously-picked target wins unless a near-tied candidate is meaningfully closer (`d(prev) <= d(nearest) * 1.1`). Suppresses oscillation on near-equidistant hostiles.

**Range gate** (`maxDistance`): out-of-range candidates neither become the nearest pick nor renew the sticky pin. Mounts slew back to `0` (forward) when no candidate is in reach. Both player and drone tick paths pass `HITSCAN_RANGE = 500 u`.

**Deterministic tie-break**: when two candidates are exactly equidistant, the one appearing first in iteration order wins. Server and client must therefore iterate `targets` in the same order. The upstream AI controller is responsible for that ordering.

### Runtime state surfaces

**Server** ([src/server/rooms/SectorRoom.ts](../../src/server/rooms/SectorRoom.ts)):

```typescript
playerMountAngles: Map<playerId, Float32Array>  // per-mount slewed angle, by catalogue index
playerSlotTargets: Map<playerId, string | null>  // sticky pin
droneMountAngles:  Map<droneId,  Float32Array>  // same for drones
droneSlotTargets:  Map<droneId,  string | null>
```

Both maps populated by `tickPlayerMounts()` and `tickDroneMounts()` each `update()`, cleaned up in `onLeave`/`evictSwarmEntity`. The drone path skips any kind whose mounts are all static (`rotationSpeed === 0`) — entries are never allocated for legacy single-mount drones.

**Client** ([src/core/contracts/IRenderer.ts](../../src/core/contracts/IRenderer.ts)):

```typescript
ShipRenderState.mountAngles?: number[]   // local + remote player ships
SwarmRenderState.mountAngles?: number[]  // drones (in-interest only)
```

For the local player, populated by `ColyseusClient.tickLocalMountAim` each tick (predicted). For remote ships and drones, populated from the snapshot anchor (authoritative).

**Wire** ([src/shared-types/messages.ts](../../src/shared-types/messages.ts)):

```typescript
SnapshotMessage.states[id].mountAngles?: number[]   // per-player, per-recipient, in-interest
SnapshotMessage.drones[].mountAngles?: number[]     // per-drone, per-recipient, in-interest
```

Both emitted only when at least one mount has slewed past 0 (avoids byte cost on legacy ships and on idle multi-mount ships). Values quantised to 4 decimals (~0.006° resolution) so the JSON serialiser dedupes trailing-noise drift across the wire.

The **binary swarm packet at v3** stays untouched. Mount-angle state lives entirely on the JSON snapshot.

## Tick-path topology

```
[server update()]
   tickPlayerMounts()       — pickTarget + rotateMountToward for every alive player
   tickDroneMounts()        — same for every drone with a rotating mount
   swarm broadcast          — binary v3 (no mount angles)
   per-recipient snapshot   — JSON, emits mountAngles for in-interest entries

[client tickPhysics(), per-tick]
   applyInput               — player input → predWorld
   predWorld.tick(1/60)
   tickLocalMountAim        — pickTarget + rotateMountToward for the LOCAL player
                              (writes mirror.ships.get(localId).mountAngles)
   updateLiveBeam (if firing) — uses the local mountAngles for fire direction

[client handleSnapshot]
   reset remote-ship predWorld state to serverTick pose
   write mirror.ships.get(remoteId).mountAngles = state.mountAngles   (preserved across per-frame rebuild)
   write mirror.swarm.get(entityId).mountAngles = drone.mountAngles
   reconciler.reconcile(...)

[client renderer.update()]
   for each ship: mountVisuals.applyMountAngles(id, mounts, ship.mountAngles)
   for each in-interest drone: same
   liveBeams + remoteLasers: derive beam fire-angle from mount.baseAngle + mountAngles[i]
```

## Lockstep + correction paths

Three actors compute mount angles:
- **server**: authoritative
- **client local player**: predicted (matches server within prediction window)
- **client remote players + drones**: anchored to snapshot

Server and client agree on target choice when their `view.players` ordering matches; the AiController/snapshot pipeline guarantees that. Mount angles diverge briefly during prediction but the snapshot anchor reseeds remote/drone mount angles on every 20 Hz frame.

**Critical:** the local player's predicted `mountAngles` are NOT overwritten by the snapshot. The local prediction owns its own surface; the snapshot's local-player `mountAngles` are read only by other observers' renderers. If you reseed locally on snapshot you'll get visible "snap-back" of the rotation animation.

The per-frame `mirror.ships.set()` rebuild in [src/client/net/ColyseusClient.ts:2033](../../src/client/net/ColyseusClient.ts) (local player) and the equivalent remote-player path **must preserve `mountAngles`** in the same `...(prev?.kind ? { kind: prev.kind } : {})` pattern as `kind`/`displayName`. Wipe = silent regression (the live beam renders at baseAngle, the ghost beam renders at mount angle, looks like a flickering "double beam").

## Visual representation

Every mount renders three Pixi `Graphics` children parented to the host sprite via `MountVisualManager`:

1. **Turret sprite** — a small 1.2 × 20 unit barrel at `(mount.localX, mount.localY)`, rotated by `-(baseAngle + currentMountAngle)` (Pixi y-flip). Coloured to match the ship's `kind.color`.
2. **Aim line** — a dotted 6/4 dash chain from the barrel tip extending along the mount's current fire direction, **for the bound weapon's effective reach** (pure `aimLineLengthForMount` → `weaponAutoFireRange`; hitscan→`range`, projectile→0.85×, missile→0.5×). Alpha 0.25 so it doesn't dominate. (Was a hardcoded 500 u for every mount — the interceptor beam, range 250, drew its guide at 2× reach: R2.14, 2026-06-12.)
3. (Phase 4b plan) **Aim arc indicator** — a faint wedge from `arcMin..arcMax`. Currently deferred; was descoped from Phase 4b because static aim-line + visible turret rotation made it redundant for the smoke-test feel. Re-instate if a future iteration wants explicit arc visibility.

`BARREL_LENGTH = 20` deliberately matches the 20 u server-side self-hit clearance offset in `handleFire`/`handleAiFire` — so the beam emerges from the visible barrel tip rather than 12 u past it. **Don't change one without the other.**

## Equinox R2 beam fixes (2026-06-12)

- **Beams stop at shield walls — client predicted beam (R2.28).** The server already absorbed beams at an active shield wall (`PlayerFireResolver`/`AiFireResolver` → `blockBeamAtWall` → `ShieldWallManager.blockShot`), but the LOCAL player's predicted live beam drew straight THROUGH an up wall: `castHitscan` resolved hits via `handleToId`, and wall span bodies are deliberately kept out of it, so a wall hit returned `null` → `updateLiveBeam` ran the beam to full `HITSCAN_RANGE`. Fix: `PhysicsWorld` keeps a separate `wallHandleToId` map (populated in `spawnWall`, cleared in `removeWall`) consulted in `castHitscan`'s miss-fallback to return a `wall-${id}` sentinel; a disabled (down) wall is excluded from `castRay` by Rapier so it stays passable. `shieldEdgeDist` already returns `hit.dist` for a non-ship/non-swarm hitId, so the predicted beam terminates exactly at the wall with no client edit. Lock: `World.wall.test.ts`.
- **Reverse-square damage falloff (R2.29).** `HitscanWeaponDef` gains an optional `falloff: { minDamageFrac }`; `hitscanFalloffFrac(dist, range, minFrac)` (pure, `WeaponCatalogue.ts`) scales applied damage from full at point-blank to `minFrac × damage` at max range as the SQUARE of normalized distance. Threaded through `WeaponFireSink.hitscan`'s optional 4th param; both resolvers scale damage (and the `hit_ack`/`_bestHitDamage`) at the hit distance. **Server-authoritative** — the client reads the scaled value off the `DamageEvent`, never predicts it (no prediction desync). The beam (`hitscan`) ships `minDamageFrac: 0.4`. Absent field ⇒ flat damage (back-compat). Locks: `hitscanFalloff.test.ts` (curve) + `hitAckContract.test.ts` (damage < flat at ~100 u, and `hit_ack == DamageEvent`).
- **Aim-line length follows weapon reach (R2.14)** — see the Visual representation section above.
- **Deferred (flagged):** the `BeamSpritePool` visual *taper* (a fading gradient along the beam to read the falloff visually) is NOT yet shipped — it would change the documented single-`Texture.WHITE`/single-drawcall batch contract and needs visual sign-off. The gameplay falloff is fully active without it.

## AI fire-gate widening (Phase 4c)

`HostileDroneBehaviour.tickCombat` had a flat body-aim tolerance of 14° (26° point-blank) — wide enough for single-mount drones whose only fire vector is their body forward. For multi-mount kinds this suppressed fires the turret AI would have resolved as hits.

The gate now widens by the kind's widest rotating-mount half-arc, pre-computed at construction:

```typescript
maxTurretHalfArc = max((arcMax - arcMin) / 2  for mount in kind.mounts where rotationSpeed > 0)
aimTolerance = baseTolerance + maxTurretHalfArc
```

- Interceptor wings ± π/6 → 14° + 30° = 44° tolerance.
- Gunship rear ± π/2 → 14° + 90° = **104°** tolerance (drone fires even at near-rear targets — the rear turret can reach).
- Legacy single-mount kinds (zero arc) → 14°, unchanged.

The fire DIRECTION the body AI provides (`(fwdX, fwdY)`) is still body-forward; per-mount adjustment is added downstream in `handleAiFire` via `+ mount.baseAngle + currentMountAngle`.

## Engineering room — `mount-test`

For phone-side smoke testing of multi-mount kinds:

```
http://localhost:5173/?room=mount-test
```

Registered in [src/server/index.ts](../../src/server/index.ts). 6 drones in a tight 250 u ring at origin, deterministic alternating `[interceptor, gunship, interceptor, gunship, interceptor, gunship]` via the new `JoinOptions.droneKinds` round-robin override. testMode (no asteroids); fire any weapon at one to mark it hostile and trigger COMBAT.

`JoinOptions.droneKinds` is plumbed through to `SwarmSpawner`'s `pickDroneKind` hook. When absent, the spawner falls back to the legacy uniform-random picker — so the option is purely additive.

## Network bandwidth

The byte-budget gate at [tests/unit/network-bandwidth.test.ts](../../tests/unit/network-bandwidth.test.ts) measures bytes-out-per-client in a deterministic scenario (4 clients × 100 drones × 60 ticks of motion). The new `mountAngles` field on `SnapshotMessage.states` and `SnapshotMessage.drones[]` is omitted whenever the angle array is all-zero, so the legacy bench scenario (all fighter/scout/heavy drones at rest, default 0 rotation) stays at the original baseline.

A multi-mount scenario will add `~4 bytes × mounts × frequency × clients` per second to the wire. For an interceptor or gunship at full rotation, that's ~120 B/s per ship per recipient — well below the noise floor of the existing ~258 KB/s aggregate baseline.

Run `EQX_CAPTURE_BASELINE=1 pnpm test tests/unit/network-bandwidth.test.ts` to recapture the baseline whenever a wire change is intentional. The checked-in baseline at [benchmarks/baselines/network-bandwidth.json](../../benchmarks/baselines/network-bandwidth.json) is the current reference.

## Files touched

| File | Role |
|---|---|
| [src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts) | `WeaponMount` + `WeaponSlot` schemas, interceptor + gunship kinds |
| [src/shared-types/messages.ts](../../src/shared-types/messages.ts) | `FireMessage.slotId`, `Snapshot.states.mountAngles`, `Snapshot.drones[].mountAngles` |
| [src/core/ai/WeaponMountController.ts](../../src/core/ai/WeaponMountController.ts) | Pure pickTarget + rotateMountToward |
| [src/core/ai/HostileDroneBehaviour.ts](../../src/core/ai/HostileDroneBehaviour.ts) | Sticky targeting via controller; widened fire gate |
| [src/core/ai/AiController.ts](../../src/core/ai/AiController.ts) | `getBehaviour()` accessor for drone-turret hostility filter |
| [src/core/contracts/IRenderer.ts](../../src/core/contracts/IRenderer.ts) | `ShipRenderState.mountAngles`, `SwarmRenderState.mountAngles`, per-mount `liveBeams`/`remoteLasers` maps |
| [src/server/rooms/SectorRoom.ts](../../src/server/rooms/SectorRoom.ts) | `tickPlayerMounts`, `tickDroneMounts`, snapshot emission, mount-aware `handleFire`/`handleAiFire` |
| [src/server/index.ts](../../src/server/index.ts) | `mount-test` engineering room |
| [src/client/net/ColyseusClient.ts](../../src/client/net/ColyseusClient.ts) | `tickLocalMountAim`, snapshot ingest, mirror-rebuild preservation |
| [src/client/render/MountVisualManager.ts](../../src/client/render/MountVisualManager.ts) | Pooled per-mount turret + aim-line graphics |
| [src/client/render/PixiRenderer.ts](../../src/client/render/PixiRenderer.ts) | Mount-aware beam render for both player and drone shooters |

## Deferred work

- **Mount-angle ring buffer** for true lag-comp on fire claims. Server currently uses the **current** mount angle for hit-test rays rather than the tick-N angle. The error is bounded by RTT × rotationSpeed (e.g. 50 ms × 4 rad/s = 0.2 rad of slew, well inside the aim tolerance). Add a `MountAngleRing` (per-ship × per-mount × 12 ticks) if a sub-degree-accuracy use case emerges.
- **`activeSlotId` UI flip**. Today every shipped kind has exactly one slot called `'primary'`. The `1/2/Q` weapon-select UI continues to drive `activeWeapon` via the legacy `FireMessage.weapon` field. When the first multi-slot ship-kind ships, flip Zustand `activeWeapon` → `activeSlotId` and drop the `weapon`/`dirAngle` fields from `FireMessage`.
- **Per-mount weapon swapping**. The catalogue already stores `weaponId` per mount as data; a future loadout UI swaps it without touching ship-kind definitions.
- **PvP-aware hostility for player turrets**. Today player turret AI picks "any drone (kind=1)" as hostile via a trivial filter. PvP will need a faction model.
- **Aim arc indicator**. Drawn as a faint wedge from `baseAngle + arcMin` to `baseAngle + arcMax`. Skipped during Phase 4b smoke testing as the rotating turret + dotted aim line already conveyed the arc visually; reinstate if telemetry shows new players struggle to "read" each kind's mount capability.
