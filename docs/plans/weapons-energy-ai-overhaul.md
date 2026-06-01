# Per-Ship Weapon Loadouts, Slot-Based Firing, Energy System & Weapon-Aware AI

> Plan authored 2026-06-01 (`id-like-you-now-mutable-noodle`). Status:
> approved-for-implementation design. This is the executable roadmap for the
> weapons/energy/AI overhaul; update the relevant CLAUDE.md files + this doc
> as steps land (Phase-Gate Ritual).

## Context

Today **every ship can fire every weapon**. `PlayerFireResolver.resolve`
(`src/server/rooms/PlayerFireResolver.ts:183,203-204`) fires the
**client-selected** weapon (the `weapon` field on the inbound `fire`
message) from every mount in the active slot and **ignores the catalogue's
`mount.weaponId`**. The client-side `WeaponSelector` UI + keyboard `1/2/Q`
let any pilot pick hitscan/laser/heat-seeker freely. The per-mount
`weaponId` field already exists in the catalogue (its docstring even
anticipates "a future loadout UI") but is unused on the player path.

This change makes each ship fire a **fixed, catalogue-defined loadout**,
binds each weapon to its own barrel (mount), groups mounts into **slots that
fire as one synchronised trigger**, rebalances the three weapons, adds an
**energy pool** that all weapons and boosting draw from, gives **AI drones
weapon-appropriate engagement ranges**, and surfaces a **prominent
top-center energy bar** plus a **MUI slot-selector** replacing the weapon
picker.

### Confirmed decisions (from the user)

1. **Weapon assignment:** `interceptor` = beams only; `missile-frigate` =
   missiles only; **all other gameplay ships = bolts only** (scout, fighter,
   heavy, gunship).
2. **Energy bar placement:** **top-center**, under the ship HUD (its own
   focal readout, separate from the top-left hull/shield cluster).
3. **Missiles:** each missile costs energy **once at launch** (no ongoing
   cost, unchanged ~6 s TTL); energy **regenerates at a steady rate**; there
   is **no hard in-flight cap and no refund**. "8 in flight at once" is only
   the sizing target used to reverse-engineer the per-missile energy cost.
4. **Per-slot firing (user clarification):** a weapon **slot** groups mounts
   that **fire together as a single trigger and only when the whole slot can
   fire** (so parallel lasers never desync). **Energy drains once per slot
   trigger, not per weapon** (the interceptor's twin beams cost one
   beam-slot's energy, not 2×). Almost all ships have exactly one slot.
5. **UI:** replace the weapon-type button with a **MUI `ToggleButtonGroup`
   slot selector** (correct MUI patterns — hoisted static `sx`, memoised
   handlers, no per-frame allocation, no listener leak).

---

## 1. The weapon/slot firing model (core change)

**Bind weapon → mount; gate & drain per slot.** A fire trigger targets the
**active slot**; the slot fires **iff every mount in it is off-cooldown AND
the ship has enough energy for the slot's cost**. When it fires, all mounts
fire their own `mount.weaponId` in the same tick, and energy is drained
**once**.

- **Server stops trusting the client's `weapon` field.** In
  `PlayerFireResolver.resolve`, delete the single
  `weaponId`/`weaponDef` resolution (`:203-204`) and instead resolve
  `getWeapon(mount.weaponId)` **inside** the per-mount loop (`:237`), moving
  the existing `mode` branches (`:265` projectile / `:278` missile / `:295`
  hitscan) inside so each barrel fires its own weapon. The `weapon` field
  stays in `FireMessageSchema` (`src/shared-types/messages/clientMessages.ts`)
  for back-compat but is ignored for selection.
- **Slot-level cooldown.** Replace the single scalar gate on
  `lastFireClientTick` (`:205-211`) with: `slotCooldown = max over active-slot
  mounts of getWeapon(mount.weaponId).cooldownTicks`; reject the whole
  trigger if `tick - lastSlotFireTick < slotCooldown`. Track fire time
  per-(shooter, slotId) so switching slots can't be exploited — a small
  `lastSlotFireTick: Map<shooterId, Map<slotId, number>>` (or reuse the
  existing scalar when a ship has one slot). For today's homogeneous,
  single-slot ships this is behaviourally identical to the current gate.
  Keep writing the existing scalar `lastFireClientTick` too (Limbo/transit
  persistence restores it — `src/server/CLAUDE.md` Phase 8 notes).
- **`hit_ack`:** still send exactly one ack per trigger (`rejected:true` when
  the slot is on cooldown or out of energy; otherwise the aggregate
  closest-hit ack — unchanged shape).
- **AI parity (`src/server/rooms/AiFireResolver.ts`):** drones already read
  `mount.weaponId` but use the *first* mount's weapon for the salvo and have
  a latent bug — the hitscan branch uses hardcoded `HITSCAN_RANGE` /
  `HITSCAN_DAMAGE` instead of the def. Move `getWeapon(mount.weaponId)` +
  the mode branch **inside** the per-mount loop and read `range`/`damage`
  off the resolved def. Slot-cooldown gate mirrors the player path
  (`droneSlotFireTick`).
- **Cleanup:** add the new slot-fire ledger(s) to every path that already
  clears `lastFireClientTick` / `playerMountAngles` (onLeave, transit,
  death, `evictSwarmEntity`) per the `src/server/CLAUDE.md` cleanup rule, or
  they leak across reconnects.

**Critical files:** `src/server/rooms/PlayerFireResolver.ts`,
`src/server/rooms/AiFireResolver.ts`,
`src/server/rooms/mountGeometry.ts` (`resolveSlotMounts`),
`src/server/rooms/CombatSubsystem.ts` (ledger ownership),
`src/server/rooms/SectorRoom.ts` (cleanup wiring).

---

## 2. Per-kind weapon assignment + balance

Catalogue lives in `src/shared-types/shipKinds/` (split files) +
`src/core/combat/WeaponCatalogue.ts`. Effective HP = shield + hull (shield
fully absorbs, no spillover — `src/core/combat/ShieldHull.ts`):
scout 180, fighter 300, interceptor 240, gunship 420, heavy 540, frigate 900.

| Kind | New weapon | Mount change |
|---|---|---|
| scout, fighter, heavy | **bolts** (`laser`) | replace the shared `LEGACY_FORWARD_MOUNT` ref with an inline `{...LEGACY_FORWARD_MOUNT, weaponId:'laser'}` clone (leave the frozen const itself `hitscan` — still used by engineering kinds/tests) |
| gunship | **bolts** (`laser`) | `forward` + `rear` mounts → `weaponId:'laser'` (`heavyClass.ts:194,206`) |
| interceptor | **beams** (`hitscan`) | unchanged (already twin `hitscan` wings) |
| missile-frigate | **missiles** (`heat-seeker`) | unchanged |
| crossguard, el (engineering-only) | leave `hitscan` | out of gameplay spawn pool — no change needed |

**Weapon tuning (`WeaponCatalogue.ts`) — propose, fine-tune during the
balance commit, lock the targets in a unit test (TTK math, not literals):**

- **Bolt (`laser`, projectile):** medium range, dodgeable, ~3-5 s kill on a
  fighter at 6 shots/s (`cooldownTicks 10`). Target: fighter (300 HP) in
  ~4 s ⇒ ~25 hits ⇒ `damage ≈ 12`. Set `maxTicks` so range ≈ 1000-1200 u
  (medium); keep `speed 1600`, `radius 3`.
- **Beam (`hitscan`):** **very close range** — drop `range 500 → ~250`.
  ~3-5 s kill; interceptor fires **2 beams/trigger** so its raw per-trigger
  damage is 2× — tune `damage ≈ 13` so a single-beam ship would kill a
  fighter in ~4 s and the interceptor's twin beams in ~2 s (its "high DPS,
  low hull" identity). NOTE: drones share this catalogue and
  `DRONE_FIRE_RANGE` derives from `HITSCAN_RANGE` — see §4.
- **Missile (`heat-seeker`):** long range, **kill most ships in 1-2 hits**.
  A salvo = 2 missiles. Tune `damage` so 2 missiles (one salvo) kills the
  common ships (scout/fighter/interceptor ≤ 300 HP) — e.g. `damage ≈ 150`
  direct (+ existing splash/`directImpulseBonus`). Reduce `cooldownTicks
  180 → ~90` (1.5 s) so the salvo cadence can sustain ~8 in flight (see §3).
  Keep `speed 400`, `lifetimeTicks 360` (range ≈ 2400 u, long).

**Bump `SHIP_KIND_CATALOGUE_VERSION` 7 → 8** (mount + numeric stat changes;
locked at 7 by `ShipKindPhysics.tuning.test.ts` — update it). Energy is
transient (respawns full, like shield) ⇒ exempt from the PlayerShipStore
hull-drift clamp (document next to shield's exemption).

---

## 3. Energy system

A per-ship energy pool that **all weapons drain per slot-trigger** and that
**boosting drains while held**, regenerating at a steady rate. Each kind has
its own `energyMax` and `energyRegenRate`.

### 3.1 Authority — server main thread is the single owner

Energy couples to **fire** (main thread, `PlayerFireResolver`) and **regen**
(main thread, like shield's `tickShieldRegen`) far more than to **boost**
(applied in the physics worker via `applyShipInput.ts:52`). The boost bit is
forwarded to the worker by the main thread (`makeInputHandler` →
`postToWorker INPUT`), so the main thread fully controls it. Therefore:

- **Boost gate** (one site): in `makeInputHandler`, before forwarding,
  strip the boost bit when `ship.energy < BOOST_TICK_COST`. Worker stays
  **unchanged** — no new worker command, no SAB field.
- **Boost drain** (one site): in a new `tickEnergy()` (called from
  `SectorRoom.update()` right after `tickShieldRegen`), drain
  `BOOST_TICK_COST` for every id in the existing `boostingPlayers` set
  (already "boost && thrust").
- **Fire gate + drain** (atomic): in `PlayerFireResolver`, after the
  cooldown gate, reject the trigger if `ship.energy < slotEnergyCost`;
  otherwise drain `slotEnergyCost` **once** for the whole slot.
- **Regen** (one site): `tickEnergy()` does
  `energy = min(energyMax, energy + energyRegenRate)` every tick — **no
  post-spend delay** (unlike shield), so the bar feels alive.

The math lives in a **pure `src/core/combat/Energy.ts`** (mirrors
`ShieldHull.ts`): `spendEnergy`, `regenEnergyStep`, `canAfford`. Core owns
the rules; server owns the value; client calls the same helpers to predict.
Document that the boost gate + boost drain are **two sites but one owner**
(same tick) — the gate prevents applying boost the drain would make negative
(Invariant #12: one correction path per state surface).

### 3.2 Client prediction + reconcile + render

Energy is driven entirely by the player's own fire/boost input, so it is
**predictable like position**.

- `predEnergy` — a plain client field on `ColyseusClient` (NOT Zustand;
  it changes per frame). In `tickPhysics`: regen + boost drain (`if
  boost && thrust`) + fire drain (in `sendFire`, subtract `slotEnergyCost`
  when a slot actually fired). Clamp ≥ 0; gate local ghost fire/boost on it
  so prediction matches the server's gating.
- **Reconcile:** add `energy` to `SnapshotMessage.states[id]` for the
  recipient's **own** ship only (notepack skips `undefined`, same trick as
  `lastInput`/`mountAngles`). On each snapshot, hard-set
  `predEnergy ← states[localId].energy` (a 1-frame snap on a 0-100 bar is
  invisible; add max-step smoothing only if it reads as jarring).
- **Render (no per-frame Zustand writes — Invariant #2):** new
  `EnergyBar.tsx` follows the `FireCooldownRing.tsx` precedent — a RAF loop
  reads `getGameClient().getPredictedEnergy()` and writes a CSS width on a
  ref'd `<div>` directly. `energyMax` (constant per kind, the denominator)
  is set once in Zustand on spawn. Add a `data-energy-pct` attribute
  (mirroring `data-shield-pct`) for E2E.

**Critical files:** `src/core/combat/Energy.ts` (new),
`src/server/rooms/schema/SectorState.ts` (plain `energy` field + seed),
`src/server/rooms/SectorRoom.ts` (`tickEnergy`, boost-strip in input
handler, seed on spawn/respawn), `src/server/rooms/SnapshotBroadcaster.ts`
(own-ship `energy`), `src/shared-types/messages/snapshotMessages.ts`
(`energy?: number`), `src/client/net/ColyseusClient.ts` (`predEnergy`,
predict/reconcile, `getPredictedEnergy`), `src/client/components/EnergyBar.tsx`
(new), `src/client/state/storeTypes.ts` + `store.ts` (`energyMax`).

### 3.3 Balance numbers (per-slot cost; tune to the duration targets)

Single-slot ships fire 6 triggers/s (`cooldownTicks 10`). Continuous-fire
duration on a full pool = `energyMax / (slotCost × 6)` seconds (regen
extends real-world sustain). Targets: **beams 5-10 s, bolts 10-20 s.** Costs
are **per slot trigger** — the interceptor pays one beam-slot cost even
though it fires two beams.

| Kind | Weapon (slot) | energyMax | slot cost | full-pool continuous fire | regen/tick (≈ empty→full) |
|---|---|---|---|---|---|
| scout | bolts | 120 | 2 | ~10 s | 0.20 (~10 s) |
| fighter | bolts | 150 | 2 | ~12.5 s | 0.25 (~10 s) |
| heavy | bolts | 180 | 2 | ~15 s | 0.30 (~10 s) |
| gunship | bolts ×2 (one slot) | 150 | 3 | ~8 s | 0.30 |
| interceptor | beams ×2 (one slot) | 180 | 5 | ~6 s | 0.40 |
| missile-frigate | missiles ×2 (one slot) | see §3.4 | see §3.4 | — | steady |

Boost: `BOOST_TICK_COST` sized so continuous boost empties a full pool in
~3-4 s (e.g. ~0.6-1.0/tick), making boost-vs-shoot a real tradeoff.

### 3.4 Missile sizing (reverse-engineered from "8 in flight")

Missile TTL = 360 ticks (6 s); a salvo = 2 missiles; the frigate has one
slot. "≈8 in flight" ⇒ over a 6 s window ~8 missiles alive ⇒ ~4 salvos/6 s ⇒
**one salvo ~every 1.5 s**. So:

- `heat-seeker.cooldownTicks ≈ 90` (1.5 s) permits that cadence.
- Steady regen must replenish one slot cost per ~1.5 s (90 ticks):
  `energyRegenRate × 90 ≈ slotCost`. Example: `slotCost = 60`,
  `energyRegenRate ≈ 0.67/tick`, `energyMax = 240` (≈4-salvo opening burst,
  then regen-paced to ~8 in flight). Missiles cost **once at launch**, no
  refund, no cap — the pool + regen + TTL naturally settle near 8 in flight.
- Boost shares this pool, so boosting the frigate temporarily reduces
  missile throughput — the intended tradeoff.

---

## 4. AI per-weapon engagement (`src/core/ai/HostileDroneBehaviour.ts`)

Server-authoritative-only (client no longer runs drone AI), pooled scratch
preserved (Invariant #14), no wire change (all derived from `this.kind` in
the constructor — no client divergence possible).

- **Compute once in the constructor** (like `maxTurretHalfArc`):
  `weaponMode` from `getWeapon(this.kind.mounts[0].weaponId).mode` and a
  per-instance `fireRange` + a `{stopDistFactor, backoffBand, engageBoost}`
  steering struct (no per-tick allocation).
- **Weapon-aware fire range** — replace the hardcoded
  `DRONE_FIRE_RANGE = HITSCAN_RANGE * 0.6` (`:13`):
  - **beam** → ~`weaponDef.range × 0.9` (≈225, very close)
  - **bolt** → ~`laser speed × maxTicks / 60 × 0.5` (≈600, medium)
  - **missile** → ~1400 (long; fires from far)
- **Steering branch in `tickCombat`** (`:277`), parameterised by mode:
  - **missile → kite:** large `STOP_DIST` (≈`fireRange × 0.9`); thrust
    **away** if the target closes inside `fireRange × 0.4`. Artillery feel
    ("stay away when engaging").
  - **beam → close:** small `STOP_DIST` (≈`fireRange × 0.5`); bore in
    aggressively, keep the brake-on-overshoot guard.
  - **bolt → dogfight:** current mid-range behaviour unchanged.
- Swap the `inRange` gate (`:370`) and the cooldown gate (`:371`, currently
  global `WEAPON_COOLDOWN_TICKS`) to the per-instance `fireRange` /
  `getWeapon(mounts[0].weaponId).cooldownTicks`.
- **Drones are NOT energy-gated.** Cooldown + (for missiles) the natural
  TTL/cadence already pace them; a per-drone energy ledger is a new
  server-only mutable surface with cleanup cost and zero player benefit.
  `ship.energy` exists only on player `ShipState`; `AiFireResolver` never
  reads energy. (Simplest correct; keeps AI lean.)

---

## 5. UI — top-center energy bar + MUI slot selector

### 5.1 Energy bar (`src/client/components/EnergyBar.tsx`, new)

Mount at the **top-center** anchor (`src/client/layout/anchors.ts` already
defines `top-center`). Visual mirrors `ShieldHullBar.tsx` (track + fill,
module-hoisted static `sx`), but the fill is driven by the **RAF/direct-DOM**
pattern from `FireCooldownRing.tsx` (read `getPredictedEnergy()` each frame,
write width on a ref'd node) — **never** a 1 Hz `HudDispatcher` write and
**never** a per-frame Zustand write. Distinct colour from hull (green) /
shield (cyan) — e.g. amber/gold. `data-energy-pct` attribute for E2E.

### 5.2 Slot selector (replace `WeaponSelector.tsx`)

Replace the weapon-type picker with a **MUI `ToggleButtonGroup` (exclusive)**
listing the local ship's **slots** (`shipKind.slots`), selecting the active
slot → a new Zustand `activeSlotId` (replacing `activeWeapon`). The fire path
already carries `slotId` (`FireMessageSchema.slotId`,
`resolveSlotMounts(kind, slotId)`). Today every ship has one slot, so the
group shows a single selected toggle (forward-compatible with multi-slot
ships).

**Correct MUI patterns (avoid the leak / per-frame-`sx` traps called out in
the request + CLAUDE.md drawer-perf rules):**
- Hoist all static `sx` objects to **module-level consts**; use `useMemo`
  only for genuinely dynamic style; never inline `sx={{...}}` per render.
- `onChange` handler via `useCallback`; ignore `null` (exclusive
  deselect).
- No manual `addEventListener` — use the component's props (no listener to
  leak); if any imperative listener is unavoidable, clean it up in
  `useEffect`'s teardown.
- Subscribe to Zustand with **narrow selectors** (`activeSlotId`, slot list)
  so the toggle doesn't re-render on unrelated store changes.

**Remove:** the weapon-type concept from input/state — Keyboard `1/2/Q`
binds and `cycleWeapon`/`activeWeapon`/`setActiveWeapon` in
`store.ts`/`storeTypes.ts` (`src/client/input/Keyboard.ts`). Rework
`FireCooldownRing` to read the active slot's cooldown
(`max(getWeapon(mount.weaponId).cooldownTicks)`) instead of `activeWeapon`.
`ColyseusClient.sendFire` reads the local ship's mounts from the catalogue
(it knows its `shipKind`) for ghost prediction instead of the selected
weapon.

**Critical files:** `src/client/components/EnergyBar.tsx` (new),
`src/client/components/WeaponSelector.tsx` → slot selector (or new
`SlotSelector.tsx` + delete), `src/client/components/MobileControls.tsx`
(swap the nested selector), `src/client/components/FireCooldownRing.tsx`,
`src/client/input/Keyboard.ts`, `src/client/state/store.ts` +
`storeTypes.ts`, `src/client/net/ColyseusClient.ts`.

---

## 6. Wire format & versions

- **`SnapshotMessage.states[id].energy?: number`** (integer-quantised),
  emitted **own-ship only** per recipient (add to the pooled `_stateEntryPool`
  / `acquireStateEntry` in `SnapshotBroadcaster`).
- **`ShipState.energy`** — plain (non-`@type`) field, seeded to
  `kind.energyMax` on spawn/respawn (where shield is seeded). Flows on the
  snapshot channel, never the Colyseus schema diff.
- **`FireMessageSchema.weapon`** kept for back-compat, ignored for selection.
- **`SHIP_KIND_CATALOGUE_VERSION` 7 → 8.** **No `SWARM_WIRE_VERSION` bump**
  (drones aren't energy-gated; no drone-visible field). No new Colyseus
  `@type`.

---

## 7. Test plan (Invariants #9 & #13 — failing test FIRST for behaviour)

**Unit (`tests/unit/`, vitest):**
- `shipKinds.test.ts` — update the mount-weapon assertions (forward mount
  `hitscan → laser`; gunship `laser`; interceptor `hitscan`; frigate
  `heat-seeker`); assert every gameplay kind has `energyMax/energyRegenRate
  > 0`.
- `WeaponCatalogue` test — lock the **TTK targets** (bolt ~3-5 s, beam
  ~3-5 s, missile 1-2 hits) via a TTK helper, not raw literals; lock
  per-weapon `energyCost` and the missile-cadence relationship.
- `src/core/combat/Energy.test.ts` (new) — `spendEnergy`/`regenEnergyStep`/
  `canAfford`: gate when insufficient, regen cap, no overspend.
- `HostileDroneBehaviour` steering test — missile kind backs off when the
  target is close and only fires far; beam kind bores to short range; bolt
  unchanged; determinism preserved.

**Integration (`tests/integration/sectorRoom/`):**
- `weaponBoundToMount.test.ts` (new) — join as scout, send a wire `fire`
  with `weapon:'heat-seeker'`, assert a **`laser` projectile** spawns
  (server ignores the client weapon). **Must fail on current code first.**
- `slotFiringAndEnergy.test.ts` (new) — slot fires only when the whole slot
  is ready; energy drains **once per trigger** (not per mount); fires gated
  when energy is depleted, then resume after regen; boost bit stripped when
  energy is low (spy `postToWorker` INPUT); `snapshot.states[localId].energy`
  drops then recovers.

**E2E (`tests/e2e/`, Playwright — narrow, `--reporter=line`, tight
timeouts):**
- `energy-bar.spec.ts` (new) — `data-energy-pct` drops on sustained fire and
  recovers; boost drains it; boost cuts out at empty.
- Rework `weapon-switching.spec.ts` → assert no weapon picker, a slot toggle
  exists, and each ship fires its **bound** weapon.
- Update combat/missile TTK specs for the new damage; re-run the
  allocation/heap specs (`combat-allocation-profile*`,
  `combat-heap-growth*`) to confirm **zero new hot-loop allocation**
  (Invariant #14 — pooled arrays, integer energy field, `Map` ops on
  existing keys).
- Re-run `feel-test-lockstep.spec.ts` on a quiet host (drone steering moved).
  Use `pnpm e2e:netgate` if the client live-loop (sendFire/predEnergy/
  reconcile) measurably shifts.

---

## 8. Sequencing (each step keeps the inner loop green; commit per step)

1. **Catalogue + version (data only).** WeaponCatalogue numbers +
   `energyCost`; per-kind mount reassignment (inline clones) + `energyMax`/
   `energyRegenRate`; bump version 7 → 8. Tests first: shipKinds / tuning /
   catalogue TTK.
2. **Pure energy core.** `src/core/combat/Energy.ts` + test. No room wiring.
3. **Weapon-bound-to-mount fire path + slot cooldown.** PlayerFireResolver
   (per-mount weapon, slot gate, ignore claimed weapon) + AiFireResolver
   parity (+ fix the hardcoded HITSCAN bug) + slot-fire ledger & cleanup.
   Tests first: `weaponBoundToMount`.
4. **Server energy authority.** `ShipState.energy` + seed; `tickEnergy()`
   (regen + boost drain); boost-strip in the input handler; fire gate+drain;
   `SnapshotBroadcaster` own-ship `energy`; snapshot type. Tests first:
   `slotFiringAndEnergy`.
5. **Client prediction + bar + slot selector.** `predEnergy` predict/
   reconcile + `getPredictedEnergy`; new `EnergyBar.tsx` (top-center);
   replace `WeaponSelector` with the MUI `ToggleButtonGroup` slot selector;
   remove weapon-type state + keyboard binds; rework `FireCooldownRing`.
   Tests first: `energy-bar`, reworked `weapon-switching`.
6. **AI per-weapon steering.** Constructor `weaponMode`/`fireRange`/mode
   params + `tickCombat` branch. Tests first: steering unit; re-run
   feel-test-lockstep on a quiet host.
7. **Balance + allocation guard pass.** Combat/heap E2E, tune TTK
   thresholds, confirm zero per-tick allocation.

---

## 9. Cross-zone / invariant guardrails

- Energy math lives in **`src/core`** (pure `Energy.ts`); server owns the
  value, client calls the same helpers — no core→server/client import.
- Energy is **computed on the main thread only**; the worker stays oblivious
  (boost gate strips the bit *before* `postToWorker`). No new worker command,
  no SAB field.
- `HostileDroneBehaviour` reading `getWeapon` is core→core (legal).
- **Zustand purity (#2):** the energy bar reads a primitive accessor in a
  RAF loop + direct-DOM write — zero per-frame store churn. The MUI slot
  toggle uses hoisted static `sx`, memoised handlers, narrow selectors — no
  per-frame `sx` allocation, no listener leak.
- **One correction path (#12):** energy = one server authority + one
  reconciled client prediction; boost gate + drain are two sites / one owner
  / same tick (documented).
- **No new hot-loop allocation (#14):** slot-fire ledgers are pre-allocated
  Maps keyed by existing ids; energy is an integer field; AI steering state
  is computed once in the constructor.

---

## 10. Verification

- Inner loop on every step: `pnpm typecheck && pnpm lint && pnpm test`, plus
  the 8 s server boot smoke (`timeout 8 pnpm dev:server` — expect
  `INFO: EQX Peri server started port: 2567`).
- Targeted E2E once the inner loop is green: the new `weaponBoundToMount`,
  `slotFiringAndEnergy`, `energy-bar`, reworked `weapon-switching`, and the
  combat-TTK / allocation specs (`--project=chromium`, `--reporter=line`,
  tight Bash timeouts, announce ETA per CLAUDE.md).
- If the client live-loop shifts measurably: `pnpm e2e:netgate`.
- On-device smoke (last, after everything is green + committed + server
  stable): confirm each ship fires only its loadout, the top-center energy
  bar drains on fire/boost and regenerates, the slot toggle renders, beam
  drones close in / missile drones kite / bolt drones dogfight.
