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

### Nose turrets (2026-11-14)

The fighter, scout, heavy, robot-square, robot-circle and robot-hexagon were drawn with a round turret cap but had a FIXED forward gun. Owner decision: "make them real turrets", then "don't retune anything except giving them a small arc". They now use `noseTurretMount(weaponId, slew)` (`shipKinds/types.ts`): the legacy forward mount (same spot, same weapon, same chin-gun art and muzzle) with one shared arc and the slew of an existing turret kind. A ship of a kind is the same for every pilot, players included.

| Kind | Arc | Slew | Slew borrowed from |
|---|---|---|---|
| fighter, scout, robot-square, robot-circle | ±20° (`NOSE_TURRET_HALF_ARC = π/9`) | 4 rad/s (`NOSE_TURRET_SLEW_LIGHT`) | interceptor wings, fighter latent wings |
| heavy, robot-hexagon | ±20° | 3 rad/s (`NOSE_TURRET_SLEW_HEAVY`) | gunship turrets |

- **Why ±20°:** small, one value for every kind, and just wider than the ±0.3 rad a fixed gun counted as covering for locks (`turretLockPick` `FIXED_GUN_HALF_ARC`, `LockSubsystem` `FIXED_BEAR`), so a target a fixed gun could lock never falls outside the turret's arc.
- **Slew split:** fighter-sized hulls (radius ≤ 15) take the interceptor's 4 rad/s, heavier hulls the gunship's 3 rad/s. No new tuning number.
- **Art and muzzle:** `isChinMount` is positional (forward mount at the hull centre), so these mounts keep the chin-gun pivot and the `muzzleClearance` shot point; the drawn gun rotates about its own pivot via `applyMountAngles`. The shot leaves at `muzzleClearance` along the slewed angle from the hull centre, so at the full 20° the shot origin sits about `(clearance − barrel) × 2 sin 10°` (≈ 3 u for a 1× fighter) to the side of the drawn tip.
- **What follows automatically (no code change):** the player's group aims through `fcTickMountAngles` / `WeaponMountTicker.tickPlayer` and fires each barrel when it bears (`mountBearsOn`); locks use the mount arc (`inMountArc`, `groupArcs`); the AI pilot's fire request widens by the half-arc (`maxTurretHalfArc`, below) and `AiFireResolver` fires only barrels that bear; `WeaponMountTicker.tickDrone` now slews these kinds' turrets (it skipped all-fixed drones).
- **Still fixed:** patrol-fighter, trader-hauler, robot-harvester, robot-nexus, el, havok.
- **Each ship's angles on the wire are its own:** `SnapshotBroadcaster.acquireMountAngles` hands every ship entry in a recipient's snapshot its own buffer (a cursor reset per recipient). It used to pool by array LENGTH, so once every nose turret had one mount, all one-turret ships in a snapshot shared one array and were drawn at the last ship's angle while their shots left down their own (the "turrets still don't turn" clips). Locks: `SnapshotBroadcaster.mountAngles.test.ts`, `tests/e2e/nose-turret-drawn.spec.ts` (reads `__eqxArtStats().turretAim`: per drawn gun, the angle handed to the renderer and the angle the art stands at).

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

**Drawn angle of a snapshot-driven ship (drones, capitals).** `net/displayMountAngles.ts` carries the latest 20 Hz snapshot angle forward at the turret's measured turning rate so the barrel turns every frame. The carried-forward angle is kept inside the mount's arc (`arcMin..arcMax`, the same bounds as the server's `rotateMountToward`): a gun slewing into its stop otherwise swung up to 10° past it and sprang back (take 7, 2026-11-14, the gunship's forward gun, which the AI pilot's orbit holds at its stop most of a fight). Lock: `displayMountAngles.test.ts` "never draws a barrel past its arc stop".

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
- Nose-turret kinds (± π/9, see "Nose turrets") → 14° + 20° = 34° (26° + 20° point-blank).
- Fixed single-mount kinds (zero arc) fire only when the nose bears (`FC_MOUNT_FIRE_TOLERANCE`).

The fire DIRECTION the body AI provides (`(fwdX, fwdY)`) is still body-forward; per-mount adjustment is added downstream in `handleAiFire` via `+ mount.baseAngle + currentMountAngle`.

## Weapon catalogue, fire classes and energy (core)

**Catalogue** (`src/core/combat/WeaponCatalogue.ts`): the single source of truth for weapon definitions.
- Each entry is a discriminated `WeaponDef = HitscanWeaponDef | ProjectileWeaponDef` describing damage, cooldown, `energyCost` (per slot trigger) and mode-specific params (range for hitscan; speed / radius / maxTicks for projectile). Lookup via `getWeapon(id)`.
- **Append-only and pure:** no DI, no I/O. Adding a weapon = adding a record + listing its id in `WEAPON_IDS`.
- The data-driven loadout binds weapons to mounts (`mount.weaponId`). The server fires `getWeapon(mount.weaponId)` per barrel and IGNORES the client's claimed `weapon` field (see `PlayerFireResolver` / `AiFireResolver`), and parameterises `spawnServerProjectile` from the `WeaponDef`. The client uses the same lookup for ghost spawn speed and the renderer-side bolt visual.
- **Do not branch on weapon id in `src/core` paths:** read fields off the `WeaponDef`. The Open/Closed boundary is the catalogue, not a switch statement.
- `src/core/combat/Weapons.ts` keeps the combat constants and pure geometry helpers (`HITSCAN_DAMAGE`, `PROJECTILE_DAMAGE`, `HITSCAN_RANGE`, `PROJECTILE_SPEED`, `WEAPON_COOLDOWN_TICKS`, `rayHitsSphere()`), now derived from the catalogue.

**Hitscan falloff: "optimal + beyond", linear.**
- A `HitscanWeaponDef.range` is the OPTIMAL range: FULL `damage` out to it.
- `falloff: { minDamageFrac, maxRangeMul }` adds a LINEAR fringe BEYOND optimal: the ray casts to `range × maxRangeMul` (the beam weapon: 250 → 325, `maxRangeMul` 1.3, so the tail is short and clearly ends), and `hitscanFalloffFrac(dist, optimalRange, maxRange, minDamageFrac)` scales damage linearly from full at `range` to `minDamageFrac` at `maxRange`. The owner chose linear: a constant fall per unit reads as a smooth taper that matches the visual beam taper.
- `maxRangeMul` absent or ≤ 1 ⇒ flat full damage in range (back-compat).
- The aim line and auto-fire still use `range` (optimal), so the guide stays at the reliable reach; only the ray and damage extend.
- **Server-authoritative:** the `WeaponFireSink.hitscan(ctx, range, damage, falloffMinDamageFrac?, maxRange?)` fifth param threads maxRange into BOTH resolvers; the client reads the scaled damage off the `DamageEvent`, never predicts it. The client beam visual (`BeamSpritePool`) draws solid to optimal, then fades to nothing across optimal → maxRange, so the visible taper == the damage band. 🔴 netgate (live combat path).
- Locks: `hitscanFalloff.test.ts` (full to optimal, linear beyond), `weapons.test.ts` (maxRange threaded to the sink), `tests/e2e/laser-falloff-probe.spec.ts` (a no-hit beam ends and tapers).

**Fire classes** (`src/core/combat/weapons/`, GEP B3): the catalogue stays the pure DATA source; this layer wraps each `WeaponDef` in a stateless flyweight (`HitscanWeapon` / `ProjectileWeapon` / `MissileWeapon` over the `Weapon` base) that owns its per-mode FIRE DECISION via a virtual `resolveFire(ctx, sink)`.
- Both fire resolvers collapse to one `getWeaponObject(mount.weaponId).resolveFire(ctx, this)` call (the resolver IS the `WeaponFireSink`).
- Fire is low-frequency, so the virtual dispatch is cheap; the per-hit damage path stays monomorphic (HC#5).
- The server work (lag-comp sweep, spawn, `laser_fired` broadcast) lives behind the zone-pure `WeaponFireSink`, injected per resolver, so player-vs-AI hitscan differences live in the sink, not the weapon.
- Adding a weapon = a catalogue row (its `mode` picks the leaf in `weapons/index.ts`); no resolver edit. Parity: `weapons/weapons.test.ts`.

**Energy** (`src/core/combat/Energy.ts`): pure scalar helpers `spendEnergy` / `regenEnergyStep` / `canAfford` + `resolveSlotEnergyCost` (a per-slot `energyCost` override wins, else the MAX over the slot's mounts' weapon `energyCost`: drain once per slot).
- **Shared brain** (unlike `ShieldHull.ts`): energy is driven by the player's own fire and boost input, so the server owns the value and the client predicts via the SAME helpers (`ColyseusClient.predEnergy`).
- Allocation-free (scalar in/out, `mount.find`, no array build), safe in the per-tick hot loop.
- Drone FIRE is not energy-gated; drone BOOST is (virtual pilot, its own server-side pool). `BOOST_TICK_COST` is the per-tick boost drain.

**Turret reach** (`src/core/combat/mountReach.ts`, capitals Phase 3): `mountTargetReach(kind, mounts)` is the ONE target-pick radius both sides use (server `WeaponMountTicker`, client `tickLocalMountAim`). It returns `HITSCAN_RANGE` for every non-capital, and for a capital its longest gun's engage range plus that mount's offset. `hasTurretFireControl(kind)` marks kinds whose turrets fire one by one (capitals).

**History.** Energy arrived with the weapons/energy/AI overhaul (2026-06-02). Falloff: R2.29 tapered within range, P3.13 replaced it with reverse-square beyond range, and the Equinox laser issue (2026-06-14) replaced that with the linear fringe (`maxRangeMul` tightened 1.5 → 1.3, after the "renders infinitely" beam; the reverse-square's "slow-then-cliff" felt like damage dropped to 0 instantly beyond range).

## Charge-up: one store, one telegraph

Some AI weapons charge before they fire: the robot orb's charge laser and the capital railgun. Players have no charge weapon (`PlayerFireResolver` has no charge logic).

**Catalogue** (`WeaponDefBase`, any mode):
- `chargeTicks`: the shot fires this many ticks after the trigger. Absent ⇒ instant.
- `chargeRelease`: what a completed charge does.
  - `'locked-direction'` (default; the robot charge laser): fire at once, down the barrel, whatever it bears on. A target that moved during the wind-up is missed.
  - `'when-bearing'` (the railgun): fire only when the mount bears on its target through the normal gates (reach, on target, line clear, lock, line of fire). If it doesn't bear, hold the charge and fire the moment it does.
- `chargeTelegraph`: how the client shows it. `'ring-line'` (default, the robot: a hot ring round the hull plus a faint line to the range) or `'mount-glow'` (a glow on the charging gun only, ramping up, no aim line).

**One store** (`WeaponMountTicker.charges`, a `MountCharges`): per AI ship, one `Int32Array` beside `droneMountReload`, indexed like the slot mounts, holding the tick each mount began charging or `NOT_CHARGING`. Made on a ship's first charge and reused (#14); `clearDrone` drops it, so a ship that dies or is evicted never fires its charge.
- **Capital turrets** (`tickCapitalMounts`): a mount with `chargeTicks` that is loaded, has a locked target and bears on it starts charging instead of firing. The turret keeps tracking while it charges. On completion, `'locked-direction'` fires at once (`releaseLockedCharge`, even with no target); `'when-bearing'` runs the normal fire gates and holds while they fail. The reload starts when the shot leaves.
- **AI salvo path** (`AiFireResolver.resolve`, non-capital drones): a slot with a charge weapon writes the trigger tick for each bearing mount into the same store; `releaseCharges(tick)` (once per tick, after the AI tick) fires the mounts whose charge (the slot's longest `chargeTicks`) has elapsed, down their barrels from the current pose. It skips capitals, which release their own.

**Snapshot** (#16, emit-when-non-zero): `drones[].chargingMask` (bit i = slot mount i charging or holding a charge) and `drones[].chargeStartTick` (the earliest charging mount's start), read from the store by `SnapshotBroadcaster` (`droneCharges`). They replaced the old `drones[].charging` boolean. **Per-mount starts:** a rail battleship's main turrets may begin charging on different ticks, so `drones[].chargeOffsets` carries one entry per SET bit of the mask (lowest bit first): that mount's start in ticks after `chargeStartTick`, clamped to u16 (`MountCharges.offsetsInto`, written into a pooled array). Emit-when-non-default: absent when every charging mount began on `chargeStartTick` (always for a lone charge). The client mirrors them as `SwarmRenderState.chargingMask` / `chargeStartTick` / `chargeOffsets` and clears them when a drone drops out of the slice.

**Client telegraph** (`render/pixi/chargeTelegraph.ts`, the one charge renderer, built once per sprite by `swarmSpriteUpdater`): per kind, the ring + line (`buildChargeTelegraphGfx`) if any mount uses `'ring-line'`, and a glow at each `'mount-glow'` mount (placed and sized from `turretLayout.shipTurrets`, turned with the drawn mount angle). The glow ramps from the start tick on the game clock: the start is latched as `fxNow − (entity tick − chargeStartTick) × 1/60 s`, so a late joiner sees the true progress and slow motion slows the ramp (#20). Each glow ramps from its own mount's start (`chargeOffsets`), so turrets that began apart glow apart. `turretFx.familyFor(…, charge)` draws any non-missile charge weapon as the 'charge' gun family, except the railgun ('rail', below). A 'mount-glow' weapon on a 'rail' gun gets the `'rail-slot'` style of the same telegraph (`chargeTelegraphStyle(w, family)`): the slot between its rails fills instead (Railgun look).

**The railgun** (`WeaponCatalogue.ts` `RAILGUN_DEF`): a capital main-battery projectile turret (carried by the rail battleship `battleship-rail`, the `fit` axis of `warshipDesign`: [capital-ships](../features/capital-ships.md#weapon-fits-plan-section-9); a mount needs only `weaponId: 'railgun'`, the charge comes from the weapon def), `chargeTicks` 360 (6 s), `'when-bearing'`, `'mount-glow'`, `cooldownTicks` 2400, damage 2400, radius 5, `killCut: { kind: 'channel', width: RAILGUN_BOLT_WIDTH }` (16 u, the drawn bolt, ≥ 2 × radius). Being on the naval list (`NAVAL_SHELL_WEAPON_IDS`) it fires an event shell, uses the naval turret bearing rule (`mountFireTolerance`: `TURRET_FIRE_MISS`) and is never locally predicted (`localFirePredicts`). It draws as the 'rail' gun family (Railgun look, below) and kicks and flashes heavier than a powder gun (`turretFx.muzzleHeft`, `RAILGUN_MUZZLE_HEFT`: recoil, flash size, flash time and a white-blue light); its slug is the long white `'slug'` streak (`FxProjectiles`, width = the bolt width). Pass-through: [shell-events](shell-events.md#railgun-pass-through-2026-11-14).

**Railgun look** (client only, no wire change). Every piece extends an existing system; the numbers are in `render/art/fx/turretFx.ts`.
- **Turret** (`familyFor` → `'rail'`, baked through the turret path by `fields.ts` `forgeRailTurret`, one atlas bake per turret like every gun): a ringed breech disc (`railGeom`: 0.4 × the mount's gunhouse width; a painted outer collar, segmented rings stepping up to a bolted hub with a dark bore) and ONE barrel of two parallel rails with an open dark slot between them, flared hex-plated shoulders where the rails leave the breech, hex panels on the rails' outer halves, cross seams and four side vents per rail (`RAIL_VENTS`). Dark gunmetal. The rails end at the shared muzzle (houseL / 2 + len, #15); they start inside the breech, so the visible barrel is longer than a naval barrel on the same mount. Naval mounts are unchanged.
- **Charge** (`'rail-slot'` in `chargeTelegraph.ts`, the one telegraph): blue-white light fills the slot from the breech to the muzzle as the charge builds (`railSlotCharge`: fill = charge fraction, brightness 0.25 → 1, rising with its square), a bright head at its front and a glow in the bore. It turns with the gun and ramps from the per-mount game-clock start like the mount glow.
- **Fire**: the naval muzzle path with the railgun heft (white-blue flash and light, the shared `recoilAt` kick). The `'slug'` streak leaves a violet-blue ion wake (`FxProjectiles.wakeLayer`, pooled streak sprites per view): pieces from the muzzle to the slug, each fading and spreading from when the slug passed it over `SLUG_WAKE_LIFE_S` (1.6 s), lingering after the slug hits (at most `MAX_FADING` 16 fading wakes). Pieces per slug by effects tier (`slugWakeSegments`): 10 / 6 / 3 / 0 (high / medium / low / minimal). `__eqxArtStats().fxWakes` counts live wakes.
- **Vent**: after a shot the rails glow hot (the gun's tip glow, stretched along the rails, `railHeatAt`, cooling over `RAIL_VENT_LIFE_S`, 2 s) and gas leaves the side vents (the gun's muzzle-smoke sprites, two per vent, `railVentPuff`: blown sideways, spark-hot white-blue for 0.25 s then grey, each vent a beat after the one behind it). Puffs drawn by tier (`railVentPuffs`): 8 / 4 / 0 / 0; firing reactions are off on the low tiers.

Locks: `railgunLook.test.ts` (family, geometry against the shared muzzle, slot fill, vent, wake and the per-tier counts), `chargeTelegraph.test.ts` (the rail-slot fill grows breech → muzzle), `FxWeapons.test.ts` (the wake lingers, then fades; pieces per tier).

**The heavy beam** (`WeaponCatalogue.ts` `HEAVY_BEAM_DEF`, plan beam-slices §8): a capital hitscan beam for the main or secondary battery, fired through the ordinary beam path (`fireNow` → hitscan sink → `laser_fired`; no charge, no structure-turret `resolveTurretBeam`). "Continuous" is its 6 Hz cadence: `cooldownTicks` 10, the compositor-stall floor. Absolute like the naval guns (not `profiled`). Numbers, against the capital pool (`energyMax` 600, regen 2/tick = 120/s): `energyCost` 45 ⇒ 270/s drain, net 150/s ⇒ a 4 s burn from full; `damage` 260 ⇒ 1,560/s, one burn kills a heavy cruiser through full shields (≈ 6,000); `range` 20,000 u, past the 5" secondary battery and short of the 8" and the main guns. `killCut: { kind: 'slice' }` ([capital-destruction](capital-destruction.md) "Kill cuts"). AI energy gating is plan step 5, not this record. Mounted by the beam fits of `warshipDesign` (`heavy-cruiser-beam` secondaries, `battlecruiser-lance` main: [capital-ships](../features/capital-ships.md#weapon-fits-plan-section-9)) with one emitter per turret (`barrels: 1`), since `AiFireResolver.fireNow` fires one ray per barrel. Lock: `tests/integration/sectorRoom/beamFits.test.ts`.

**Heavy beam follow-through** (owner, game feel: "the beam should not turn after the kill and show for half a second or one second through the clean cut"): `followThroughTicks` 45 (0.75 s game time) on the record; no other weapon has one. When a heavy-beam turret's shot KILLS what it hit (the room's `applyDamage` returns `destroyed`; the hitscan sink notes it and `AiFireResolver.fireMount` returns `'killed'`), `WeaponMountTicker.tickCapitalMounts` drops the dead target and sets the mount's `droneMountFollowUntil` to tick + 45 (one `Int32Array` per capital, made once, #14). Until then the mount skips targeting (`followThrough`): it holds the kill's WORLD bearing, not its angle on the hull: at the kill it records hull + base + mount angle (`droneMountFollowBearing`, one `Float32Array` per capital, #14), and each tick trains toward that bearing minus the current hull and base angles through `rotateMountToward` (the one writer, #12), so the beam doesn't swing as the AI pilot keeps turning the hull (a hull-relative hold, found on film, slid the beam ~2° down the victim's hull). Arc and traverse rate bind as always: a hull turning faster than the turret can follow drags the beam only by the difference, and a bearing outside the arc stops at the arc edge. It fires at its own cadence (`cooldownTicks` 10 ⇒ 4 more beams) down that line with no target. Each beam is an ordinary hitscan shot: it runs to its range or hits the first thing on the line (a ship behind, a wreck piece of the victim, with the usual damage and knock-back). The hull's own deck (`mountLineClear`) and a FRIENDLY on the line still hold it; a wreck piece does not (`lineOfFireBlocked(…, passWrecks = true)`, `SectorRoom.lofPassWrecks`), else the victim's own wreck would cut the burn short. A kill during the follow-through doesn't extend it. Then the mount searches afresh (`RETARGET_TICKS`) or trains home. The client needs nothing: the held angle rides the snapshot `mountAngles` and the beams are ordinary `laser_fired` events. On film the burn shows ~1.07 s (45 ticks plus the client's 450 ms beam fade). Gate reasoning: [fire-control](fire-control.md) "Kill follow-through". Locks: `tests/integration/sectorRoom/beamFollowThrough.test.ts`, `WeaponCatalogue.test.ts`.

**Heavy beam look** (`src/client/render/beamStyles.ts`): `HEAVY_BEAM_STYLE`, a violet (`HEAVY_BEAM_COLOR`, exported for the slice-cut wreck glow) core 10 u wide (fighter beam 2 u) with `glowScale` 3 for the `?fx=new` halo / flow / flare. No wire change: the client finds the mount on the shooter's kind by `laser_fired.mountId` (`findMount`) and `remoteBeamStyleForMount` returns the heavy style for a `heavy_beam` mount, else null (the pool's fighter style). It draws in the SAME remote `BeamSpritePool` and `FxBeams` as fighter beams, as a per-beam `BeamView.style` override (no new pool; same textures, so the batch holds). Inside the pool a styled beam goes to `styledContainer`, a sibling of the pool's `container`: `LaserGlow` puts one orange glow filter on the whole remote container, and inside it the violet core read as a thin orange-red line. The styled lane has no filter (no extra filter pass; an empty lane is hidden), so the heavy beam carries only its own colour, plus its `glowScale` halo under `?fx=new`. Its core is never under `HEAVY_BEAM_MIN_SCREEN_PX` (12) screen px wide (`minScreenPx`, from the camera scale, like `SHELL_MIN_SCREEN_PX`): at capital zoom 10 u is under a px, thinner than a fighter beam's glow. Burn, not strobe: a remote beam holds full brightness until `REMOTE_BEAM_FADE_MS` (150) before its TTL; AI beams live 250 ms, which against a 167 ms (10-tick) cadence would dip to ~55 % between shots, so `remoteBeamTtlMs` gives the heavy beam `HEAVY_BEAM_TTL_MS` 450 (fade + cooldown + jitter margin). The projector turret is the ordinary hitscan `beam` turret family; its tip glow burns violet and ~1.8× larger (`MountVisualManager`). Locks: `beamStyles.test.ts`, `BeamSpritePool.solidTaper.test.ts`, `BeamSpritePool.heavyBeam.test.ts`, `LaserGlow.test.ts`.

**Test trigger `chargeTicksCap`** (testMode room / join option, URL `?chargeTicksCap=N`, harness `chargeTicksCap`): no capital-turret charge lasts longer than N ticks (`WeaponMountTicker.chargeTicksOf`), so a test can line ships up on a rail line and fire without the 6 s wait. The client telegraph still ramps over the weapon's own charge.

**Test trigger `traverseTicksCap`** (testMode room / join option, URL `?traverseTicksCap=N`, harness `traverseTicksCap`): no capital turret takes longer than N ticks to train a full turn, 0 = snap (`WeaponMountTicker.traverseDt`), so a test needn't wait out a 16" turret's ~4°/s traverse. Capital turrets only.

Locks: `tests/unit/capitalMountCharge.test.ts` (charge then fire, hold off bearing, locked-direction, death cancels), `tests/integration/sectorRoom/capitalMountCharge.test.ts` (snapshot mask + start, fires after the charge, death cancels), `tests/integration/sectorRoom/chargeLaser.test.ts` (robot), `SnapshotBroadcaster.droneCharge.test.ts` (incl. per-mount offsets), `snapshotRemoteSync.charging.test.ts`, `chargeTelegraph.test.ts` (incl. per-mount ramps), `tests/integration/sectorRoom/railgun.test.ts` (`chargeTicksCap`).

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

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Dynamic weapon mounts — latent slots (Equinox Phase 4 WS-B3).** Ship kinds declare LATENT mount slots (`ShipKind.latentMounts`, inactive geometry); a ship-level upgrade `activate_mount { shipId, slotId, weaponId }` activates one PER SHIP INSTANCE (persisted in the roster `mounts` JSON). The activated mounts are PUBLIC — they ride `SnapshotMessage.states[].mounts` (emit-when-non-empty, NO `SWARM_WIRE_VERSION` bump — slim JSON like `level`), mirrored ONCE via `applyActivatedMounts` ([net/snapshotRemoteSync.ts](../../src/client/net/snapshotRemoteSync.ts)) onto `mirror.ships[id].activatedMounts` (active hulls) + the lingering entry inside `snapshotShipRouter` (parked hulls). **GEOMETRY is looked up CLIENT-SIDE by `(kind, slotId)` from the catalogue — never on the wire (the scrap-collider trick).** The per-instance mount list `[...kind.mounts, ...activated]` is resolved by the shared pure `resolveInstanceMounts` / `resolveInstanceFireMounts` ([@shared-types/shipKinds/slots](../../src/shared-types/shipKinds/slots.ts)) — the SAME resolvers the server uses, so the predicted aim + beam + ghosts match the authoritative mount angles (lockstep, invariant #12). It is the `mountAngles[]` index space (`tickLocalMountAim` sizes its array by it; `localShipMounts` / `updateLiveBeam` / `sendFire` use the firing set). The renderer draws the extra barrels via `shipSpriteUpdater` → `MountVisualManager.ensureForInstance` (rebuilds the cluster when the activated set changes via `mountSig`). The UI is the `UpgradeModal`'s "Weapon mounts" section (`onActivateMount` → `ColyseusGameClient.activateMount`; closes/refreshes on the `mount_activated` echo, which patches the Zustand roster's `mounts`). Locks: `slots.dynamicMounts.test.ts`, `snapshotRemoteSync.activatedMounts.test.ts`, `MountVisualManager.test.ts`, `UpgradeModal.test.tsx` (WS-B3 describe), `tests/integration/sectorRoom/activateMount.test.ts`. **Netgate required** (mount/fire + snapshot are live-loop) — deferred to the human gate. Full story: [docs/architecture/weapon-mounts.md](../../docs/architecture/weapon-mounts.md).

### Multi-mount mirror surfaces (Phase 2c–4c, 2026-05-11)

The renderer mirror exposes per-mount data on three surfaces, all keyed by mount id (from the ship-kind catalogue):

- `ShipRenderState.mountAngles?: number[]` — per-mount slewed angle in arc-local frame, **indexed by catalogue mount-order** (`kind.mounts`). For the **local player**, populated each tick by `ColyseusClient.tickLocalMountAim` → `fcTickMountAngles` (predicted, aimed at each group's lock). For **remote players**, populated by the snapshot handler from `snap.states[id].mountAngles` (authoritative). Undefined ⇒ renderer falls back to `baseAngle`. **Catalogue-indexing is load-bearing AND was latently violated (2026-06-05 fix).** Both readers index by catalogue order — the live-beam direction (`localKind.mounts.findIndex(m => m.id === mountId)`) and the turret sprites (`shipSpriteUpdater` → `MountVisualManager.applyMountAngles(id, kind.mounts, mountAngles)`). The local writer `tickLocalMountAim` USED to size + index the array by the **active SLOT's** mounts (`localShipMounts()` = `resolveSlotMounts`, slot-local order) — correct ONLY while a slot is the full catalogue in catalogue order (true for every ship today, so the bug was latent). The write now goes through `fcTickMountAngles(angles, catalogueMounts, …)` (fire control; the former `combat/localMountAim.ts` helper is deleted): it writes catalogue-indexed, one entry per instance mount, each aiming at its group's lock. The moment a kind ships a slot that is a subset/reorder of `kind.mounts`, slot-local indexing made the local player's beams + turrets read the WRONG mount's angle (or `undefined` → base) — remote players were always fine (server writes catalogue-indexed).
- `SwarmRenderState.mountAngles?: number[]` — same field on drones. Populated only for **in-interest drones** from `snap.drones[].mountAngles`. Out-of-interest drones leave it undefined and their barrels render at `baseAngle` until they re-enter interest.
- `RenderMirror.liveBeams: Map<mountId, BeamData>` and `RenderMirror.remoteLasers: Map<shooterId, Map<mountId, BeamData>>` — per-mount beam state. The pre-2c single `liveBeam` and flat `remoteLasers` shapes are gone.

**Per-frame `mirror.ships.set()` rebuild MUST preserve `mountAngles`.** The local-ship update in `ColyseusClient.updateMirror()` and the remote-ship update in `syncMirror()` both reconstruct each ship's mirror entry from scratch (predWorld pose + lerp offset). Non-spatial fields need explicit `...(prev?.X ? { X: prev.X } : {})` preservation or they wipe at 60 Hz. The fields currently in this category: `kind`, `displayName`, `mountAngles`. Adding any new non-spatial field to `ShipRenderState`? Add it to BOTH rebuild sites or it disappears silently.



`MountVisualManager` ([src/client/render/MountVisualManager.ts](../../src/client/render/MountVisualManager.ts)) owns per-mount Pixi `Graphics` (turret sprite + dotted aim line). One cluster per ship sprite (player AND drone), pooled across the ship's lifetime. The `applyMountAngles(shipId, mounts, angles?)` method updates rotations each frame; undefined `angles` snaps every mount to baseAngle. Renderer despawn path calls `removeShip(shipId)` to free the cluster.

`BARREL_LENGTH = 20` deliberately matches the 20 u server-side self-hit clearance in `SectorRoom.handleFire`/`handleAiFire` so beams emerge from the *visible* barrel tip. Don't change one without the other.

The aim-line preview is drawn as a dotted chain (Pixi v8 `Graphics` has no native dashed stroke — we draw short segments manually). Its length is **per-mount, = the bound weapon's effective reach** via the pure `aimLineLengthForMount` (`render/aimLineLength.ts` → `weaponAutoFireRange`: hitscan→`range` e.g. 250, projectile→0.85× max travel, missile→0.5× max travel). It used to be a hardcoded 500 for every mount, so the interceptor beam (range 250) drew its guide at 2× the actual reach (R2.14, 2026-06-12). `6 u on / 4 u off`, alpha 0.25; the dash chain rotates with the parent mount container; no per-frame redraw. Lock: `aimLineLength.test.ts`.

See [docs/architecture/weapon-mounts.md](weapon-mounts.md) for the call-graph and the "do not add a second correction path" rule.

### Beam length is `scale.x ÷ texture.width`, NOT `scale.x = worldLen` (Equinox laser issue, 2026-06-14)

`BeamSpritePool` draws each beam segment as a stretched `Sprite`. A Pixi sprite renders `worldLen = scale.x × texture.width`, so the world length must be set as **`scale.x = worldLen / texture.width`**. The solid core uses the 1×1 `Texture.WHITE` (÷1, fine), but the **gradient + fade textures are 256 px WIDE** (they have to be — that's where the horizontal fade lives). Setting `scale.x = worldLen` on those rendered the fade tail **256× too long** (a 75 u tail → ~19 200 u): the "fade" stretched off any screen at any zoom, so in empty space the beam looked SOLID to infinity and "never tapered" — the long-standing "laser renders infinitely / flies off the screen" bug. **Headless unit tests fall back to `Texture.WHITE` (1×1) for the canvas textures, so they could NEVER see this** — the fix had "passed" four rounds of screenshots while staying broken on-device. Lock: `BeamSpritePool.solidTaper.test.ts` now injects a genuine 256-px `Texture` and asserts the DRAWN world length (`scale.x × texture.width`, exposed by `solidLenAt`/`fadeTailAt`) equals the intended length. **The damage falloff is LINEAR + bounded at `range × maxRangeMul` (interceptor 250 → 325); the matching visual is solid to `optimalRange × VISUAL_BEAM_SOLID_FRAC` (`ColyseusClient`, default 0.4 = inner 100 u) then a long gradual fade to nothing at maxRange — purely visual, `solidDist` never feeds damage.** Verified end-to-end (no-hit empty-space + hit cases) by `tests/e2e/laser-falloff-probe.spec.ts`, which forces `?zoom=` for a deterministic capture (the spawn camera-zoom ease otherwise lands before/after screenshots at different scales — a real comparison trap that masked the bug, see `docs/LESSONS.md` 2026-06-14).

## Core contract reference

Moved from `src/core/CLAUDE.md` (section "WeaponMountController contract").

**Exports:**

- `pickTarget(shipX, shipY, targets, prevTargetId, isHostile, options?)` — sticky target picking. Iterates `targets`; nearest hostile within `options.maxDistance` wins UNLESS the previous target is within `STICKY_HYSTERESIS_FACTOR * d(nearest)`. Returns `MountTargetView | null`.
- `rotateMountToward(currentMountAngle, desiredBearing, mount, dtSec)` — clamp the target into `[arcMin, arcMax]`, then slew toward it by at most `rotationSpeed * dtSec` per call. Returns the new mount angle, ship-relative, arc-local (`0` = barrel at rest).
- `wrapPi`, `clampToArc` — primitives exposed for tests / future composition.

**Lockstep determinism rules:**

1. **Tie-break by iteration order.** When two hostiles are exactly equidistant, the one appearing first in `targets` wins (`<` comparison rejects ties). Server and client MUST iterate `targets` in the same order. The upstream AI controller is responsible.
2. **Per-instance state owned by the caller.** `prevTargetId` lives on the caller (drone behaviour, player slot). Not in the controller. Reset purely by `markHostile`/`purgeHostility`/time-decay — both sides fire these symmetrically.
3. **Hostility filter is `(id) => boolean`.** Drone callers pass `id => hostileTo.has(id)`. Player turret callers pass `id => id.startsWith('swarm-')` (any drone hostile to the player). Same filter semantics on both sides; never read from a per-side data source that diverges.

**Sticky hysteresis factor** (`STICKY_HYSTERESIS_FACTOR = 1.1`) — keep the previous target while it's within 10 % distance of the nearest alternative. Below this, swarm-density edges cause flapping; above, the player feels the turret "miss obvious closer targets". 1.1 is the empirical sweet spot from drone-AI sticky-targeting smoke tests.

If you find yourself adding a "smarter" target-pick policy (lead-aim, predicted closing rate, threat tier), do it BY EXTENDING `MountTargetView` and `PickTargetOptions` — not by reaching into the call sites. The pure-module contract is what makes lockstep auditable.

**Smarter selection (Part C, weapon-autofire-boost-mechanics).** `pickTarget` was extended (per the rule above — fields, not call-site branches) with: `healthWeight` (score `= d²·(1 + w·health/maxHealth)`, biasing toward low-HP targets — "finish the wounded"), `switchMargin` (commitment in score space — resists target-flapping; default `stickyHysteresisFactor²` ⇒ byte-identical to the old squared-distance hysteresis), `dwellTicks`/`ticksSincePrevTarget` (hard switch-DELAY, server-AI only — deterministic server tick), and a per-target `hostile?` field that, when defined, OVERRIDES the `isHostile(id)` callback. **The `hostile` flag is the single-viewer alloc-free path** (the client's local player carries hostility on each `LocalAimTarget`); the per-viewer callback stays for the server (hostility is per-player). Both yield the same boolean for the same (target, viewer), so client/server picks stay in lockstep. **Absent options ⇒ behaviour is byte-identical to pre-Part-C** (locked by `WeaponMountController.test.ts`). Shared player-aim tuning lives in `PLAYER_AIM_HEALTH_WEIGHT` / `PLAYER_AIM_SWITCH_MARGIN` (exported) — the client `tickLocalMountAim` and the server `WeaponMountTicker.tickPlayer` MUST pass identical options (mount-angle lockstep, Invariant #12). The drone-AI body target (`HostileDroneBehaviour`) uses `healthWeight` + a real `dwellTicks` (server-only). Player health-weighting needs drone HP on the client — synced via the slim `SnapshotMessage.drones[].hp` percent (Part C3).

**`AiController` pending-hostility buffer (Part C).** `markHostile` for a not-yet-registered entity is now BUFFERED and applied on `register` (cleared by `unregister`/`purgeHostility`/`clear`). Fixes the `startHostile`-at-join / aggro-before-interest race where client hostility was silently dropped (the `bot_aggro` arrived before the client's first swarm packet registered the drone). Server-side it's inert (drones register at spawn before any `markHostile`), so the live loop is byte-identical.

See [docs/architecture/weapon-mounts.md](../../docs/architecture/weapon-mounts.md) for the full call-graph and the "do not add a second correction path" rule, and [docs/features/auto-fire-and-boost.md](../../docs/features/auto-fire-and-boost.md) for the player-facing behaviour.
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Combat Architecture (Phase 4) — mounts

- **Multi-mount fire path (Phase 2a–4c)**: `handleFire` and `handleAiFire` iterate the firing ship's active-slot mounts via `resolveSlotMounts(kind, slotId?)`. Each mount produces an independent `laser_fired` broadcast with its own `mountId`, fire-from-position (`mountWorldOrigin(ship.pos, ship.angle, mount)` plus the SHARED muzzle distance along the mount world direction — `core/combat/muzzle.ts` `shipMountMuzzle`: a turning turret fires from its drawn barrel tip, a chin gun keeps the 20 u clearance (drones 16 u). Structure turrets fire from `structureTurretMuzzle` (bolts, missiles, and the drawn beam start); the projectile pipeline skips the firing owner, so a muzzle inside the footprint is safe. Turrets T3; parity lock `tests/unit/muzzleParity.test.ts`, #15), and lag-comp hit-test ray. The per-mount weapon resolves off `mount.weaponId` (data-driven; future loadout swap requires only catalogue edits). Aggregate `hit_ack` reports the closest mount-hit across the salvo.
- **Server-authoritative mount rotation**: `tickPlayerMounts()` and `tickDroneMounts()` run each `update()` and write to `playerMountAngles: Map<playerId, Float32Array>` + `droneMountAngles: Map<droneId, Float32Array>`. Cost: `playerMounts` ≈ 0.001–0.025 ms / tick at 1 player; `droneMounts` ≈ 0.016 ms avg / 0.033 ms max across 7 sectors (measured via `tick_budget`). `handleFire` reads `playerMountAngles[shooterId][mIdx]` for each mount's ray direction (no per-mount ring buffer yet — see `weapon-mounts.md` "Deferred work"). Cleanup paths (onLeave, transit, death, evictSwarmEntity) MUST clear both maps alongside `lastFireClientTick` or the maps leak across reconnects.
- **Per-recipient snapshot mountAngles**: `SnapshotMessage.states[id].mountAngles?` and `SnapshotMessage.drones[].mountAngles?` are emitted only when at least one mount has slewed past 0 — legacy single-mount kinds omit the field entirely, zero byte cost. Values quantised to 4 decimals (`Math.round(angle * 10_000) / 10_000`) so the JSON serialiser dedupes trailing-noise drift.
- **Drone `hp` percent (Part C)**: `SnapshotMessage.drones[].hp` (0-100 integer) is emitted by `SnapshotBroadcaster` ONLY for DAMAGED in-interest drones (full-HP omit it → the client treats absent as 100 %), so undamaged sectors pay zero extra bytes. Sourced from `swarmHealth` ÷ `getDroneMaxHealth(shipKind)`. It's a slim non-pose JSON field alongside `mountAngles`/`shieldDown` — **no `SWARM_WIRE_VERSION` bump** (pose still flows on the binary channel). The client decodes it to `SwarmRenderState.healthFrac` for health-weighted player turret aim. **Netcode-health gate (Invariant #8) applies** — the slice + the lockstep player-aim path are live-loop.
- **AI fire-gate widening**: `HostileDroneBehaviour.tickCombat` widens body-aim tolerance by the kind's `maxTurretHalfArc` (computed once at construction from the widest rotating mount's `(arcMax - arcMin) / 2`). Without this, drones with rotating turrets suppressed fires the turret AI would have resolved as hits. For legacy zero-arc kinds `maxTurretHalfArc = 0`, so the gate collapses to the pre-4c 14° / 26° tolerance.
- **`JoinOptions.droneKinds`**: deterministic ship-kind sequence for drone spawns (round-robin). When set, the spawner uses this instead of `pickRandomShipKind()`. Used by the `mount-test` engineering room. Absent ⇒ legacy random picker, no behavioural change.
- **Phase 6c — drones only see active hulls**: the AI view rebuild block in `SectorRoom.update()` filters `playerToSlot` entries on `ship.isActive === true`. Lingering hulls (Phase 6b — players who disconnected within the 15-min linger window OR whose ships were displaced by a fresh spawn) are skipped, so drones do not target them. The `hostileTo` set still remembers the playerId, so when the player rebinds (active again) the drone immediately resumes targeting — that's intentional. Lock test: [tests/integration/sectorRoom/droneTargetActiveOnly.test.ts](../../tests/integration/sectorRoom/droneTargetActiveOnly.test.ts). Client-side prediction is already correct via the snapshot translator in `ColyseusClient.handleSnapshot` (it skips `isActive=false` entries when building the playerId-keyed local mirror), so the Input Symmetry Rule is preserved without a separate client gate.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Phase 4 Dynamic weapon mounts (WS-B3) — latent slots (plan: effervescent-umbrella)**: ship kinds declare LATENT mount slots (`ShipKind.latentMounts?: WeaponMount[]` — full geometry + a default weaponId, INACTIVE until activated; the fighter has two latent wing hardpoints). Append-only record-SHAPE change ⇒ `SHIP_KIND_CATALOGUE_VERSION` 11→12 bumped in the same PR; **NO `SWARM_WIRE_VERSION` bump** (activated-mount state rides player `ShipState`/roster, not the drone binary core). A ship-level upgrade `activate_mount { shipId, slotId, weaponId }` (strict zod, `clientMessages.ts`) → `SectorRoom.activateMount` activates the NEXT latent slot + binds the player's chosen weapon, PER SHIP INSTANCE (D8 — persisted on the roster `mounts` JSON as `ActivatedMount[]`). Validation: ownership (`row.playerId === playerId`) then `isLatentSlot(kind, slotId)` then not-already-active — a foreign / unknown / non-latent / duplicate request is a SILENT no-op. Echo `mount_activated { shipInstanceId, mounts }`. **The per-instance mount list is the lockstep seam** — three pure resolvers in [`src/shared-types/shipKinds/slots.ts`](../../src/shared-types/shipKinds/slots.ts) are the ONE place activated-slot→geometry lives (geometry by `(kind, slotId)`, NEVER on the wire — the scrap-collider trick): `resolveActivatedMounts` (catalogue geometry + the player's weaponId), `resolveInstanceMounts` = `[...kind.mounts, ...activated]` (the `mountAngles[]` INDEX SPACE — base keep catalogue indices, activated append), `resolveInstanceFireMounts` = `[...active-slot, ...activated]` (the FIRING set; activated always fire). `WeaponMountTicker.tickPlayer` sizes the angle array by the FULL instance list + aims only the firing subset; `PlayerFireResolver` resolves the firing set + reads each firing mount's angle by its index in the full instance list. `ShipState.mounts` (a PLAIN instance field, NOT @type-decorated, like statAlloc) is seeded from the roster on spawn/restore/reclaim. The activated mounts ride the PUBLIC `SnapshotMessage.states[].mounts` slice (emit-when-non-empty, for active AND lingering hulls — others render the extra turrets); `mountAngles[]` (already variable-length) carries the activated slots' angles with no wire bump. Locks: `slots.dynamicMounts.test.ts` (pure resolvers), `messages.test.ts` (`ActivateMountSchema`/`MountActivatedEventSchema`), `tests/unit/shipKinds.test.ts` + `ShipKindPhysics.tuning.test.ts` (version 12), `tests/integration/sectorRoom/activateMount.test.ts` (activate→fires-from-it / non-activated-doesn't / persists / foreign+non-latent dropped). **Netgate** required (mount/fire + snapshot are live-loop) — deferred to the human gate. Full story: [docs/architecture/weapon-mounts.md](weapon-mounts.md).

## History

Player aim before lock-to-fire (superseded by root invariant #19: player mounts now aim only at their group's lock):

  - **Player aim is hostile-only + health-weighted (Part C, weapon-autofire-boost-mechanics).** `WeaponMountTicker.tickPlayer` filters candidates through the drone's `hostileTo` set (per-player, same source as `tickDrone`) and biases the pick toward low-HP drones via the SHARED `PLAYER_AIM_HEALTH_WEIGHT` / `PLAYER_AIM_SWITCH_MARGIN` constants — **identical options to the client's `tickLocalMountAim`** so the predicted beam and this authoritative mount angle agree (mount-angle lockstep, Invariant #12). Drone health comes from `swarmHealth` (passed LAZILY — `() => this.swarmHealth` — because the shield/hull router that owns the map is constructed AFTER the ticker in `SectorRoom`'s constructor; eager eval threw at boot). The same `swarmHealth` feeds the snapshot `drones[].hp` so client + server read the same health signal.

The visible bug when this rule was broken: the local player's interceptor showed two correctly-rotated wing beams via the one-shot ghost projectile path (which carries pre-computed endpoints) but the continuous `liveBeam` rendered straight forward — because the renderer re-derives beam direction from `mirror.ships.get(localId).mountAngles` each frame, and that field was being wiped between `tickLocalMountAim`'s write and the renderer's read.
