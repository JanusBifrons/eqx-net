/**
 * The grid pulse (speed-dial-resource-structures plan, Phase 3) — the 1 Hz
 * heartbeat that drives the whole logistics web. Runs OFF the 60 Hz physics tick
 * (LivingWorldDirector pattern); `pulse()` is directly callable so tests drive
 * it deterministically without wall-clock waits.
 *
 * Each pulse, in order:
 *   1. Rebuild grid topology if `registry.topologyDirty`.
 *   2. Construction flow: each blueprint reachable from a Capital with minerals
 *      receives up to `CONSTRUCTION_PULSE_AMOUNT`/pulse, debited from that
 *      Capital. On completion → `isConstructed = true`, HP reset to max,
 *      topology dirtied (the node now relays). Dry source ⇒ construction simply
 *      pauses (emergent, no flag).
 *   3. Repair: damaged BUILT structures receive up to `REPAIR_PULSE_AMOUNT`/pulse
 *      at `REPAIR_COST_PER_HP` per HP.
 *   4. Deconstruction: `isDeconstructing` structures drain at
 *      `DECONSTRUCTION_RATE_KG`/pulse, returning minerals to their Capital;
 *      removed when fully reclaimed.
 *   5. Flash every connection that carried flow (drives the client `grid_pulse`).
 *
 * Power is AGGREGATED (not routed per-connection), so power doesn't flash — only
 * the mineral streams do. The single Phase-3 flow material is `minerals`.
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon, isWeaponId, type WeaponDef, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { MINING_BEAM_PLAYER_DPS } from '../../core/combat/miningBeamHazard.js';
import { Grid, type GridObstacle } from '../../core/structures/Grid.js';
import { chargeStep, dischargeStep, drainPower } from '../../core/structures/batteryPower.js';
import type { Connection } from '../../core/structures/Connection.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_COST_PER_HP,
  DECONSTRUCTION_RATE_KG,
  CONNECTION_THROUGHPUT,
  MINING_BEAM_CADENCE_MS,
} from '../../core/structures/structureGridConstants.js';
import { autoConnectStructure, buildGridNodes } from './structureGridView.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** Cap on reconnect attempts per pulse so a sector full of permanently-stranded
 *  structures (e.g. collinear-blocked leaves) can't make the 1 Hz pulse rescan
 *  the whole registry every beat. Bounded work; the next pulse retries the rest. */
const MAX_RECONNECT_ATTEMPTS_PER_PULSE = 8;

/**
 * Resolve a laser turret's CONTINUOUS-beam firing params (playtest 2026-06-10
 * Issue 5 — "defence structures fire in pulses instead of constantly, like the
 * player does"). All laser beam weapons now work the same everywhere: the
 * turret fires its bound catalogue beam weapon (`mount.weaponId`) on that
 * weapon's standard cooldown — a steady stream of small hits the client renders
 * as one continuous beam (its laser TTL > the beam cadence) — instead of one
 * big lump every `fireRateMs`. Per-hit damage is rebalanced to preserve the
 * kind's tuned DPS (`weaponDamage / fireRateMs`) across the faster cadence, so
 * total damage ≈ today's. `fireRateMs`/`weaponDamage` are retired as a PULSE
 * gate and repurposed as the DPS budget.
 *
 * Pure + scalar in/out — unit-locked independent of the room.
 */
export function resolveTurretBeam(
  weaponDamage: number,
  fireRateMs: number,
  beamCooldownTicks: number,
): { cooldownMs: number; perHitDamage: number } {
  const cooldownMs = (beamCooldownTicks / 60) * 1000;
  const dps = fireRateMs > 0 ? weaponDamage / (fireRateMs / 1000) : 0;
  return { cooldownMs, perHitDamage: dps * (cooldownMs / 1000) };
}

export interface StructureGridHooks {
  registry: StructureRegistry;
  /** Read a structure's current hull (from `swarmHealth`). */
  getHealth(id: string): number;
  /** Write a structure's hull (into `swarmHealth`). */
  setHealth(id: string, hp: number): void;
  /** Despawn a structure's swarm entity (used by deconstruction). */
  despawn(id: string): void;
  /** Phase 4 — nearest mineable asteroid (swarm kind 0) within `range` of
   *  (x, y), or null. Returns the asteroid's dense entityId + pose. */
  findNearestAsteroid(x: number, y: number, range: number): { entityId: number; x: number; y: number } | null;
  /** WS-4 / R2.27 — draw up to `amount` from an asteroid's FINITE resource pool;
   *  returns the amount ACTUALLY mined (0 once exhausted). Absent ⇒ infinite
   *  (pre-WS-4 / unit-harness fallback). MUST be reachable only from mining —
   *  combat never depletes asteroid resources (asteroid-interaction-model ADR). */
  drawAsteroidResources?(entityId: number, amount: number): number;
  /** Phase 5 — nearest drone (swarm kind 1) within `range` of (x, y), or null.
   *  Returns the drone's registry id (for damage) + entityId + pose. */
  findNearestDrone?(x: number, y: number, range: number): { id: string; entityId: number; x: number; y: number } | null;
  /** Phase 5 — apply turret damage to a target through the standard path. */
  applyDamage?(targetId: string, shooterId: string, damage: number): void;
  /** Phase 5 — broadcast the turret fire beam (laser_fired). */
  broadcastBeam?(shooterId: string, fromX: number, fromY: number, toX: number, toY: number, targetId: string, mountId?: string): void;
  /** WS-8 (R2.15) — spawn a server PROJECTILE bolt from a Bolt Turret toward its
   *  target (the player/AI fire path's `spawnServerProjectile`, ownerId = the
   *  turret's `pstruct-` id). Absent ⇒ no bolt (unit-harness fallback). */
  spawnProjectile?(shooterId: string, x: number, y: number, vx: number, vy: number, damage: number, radius: number, maxTicks: number, weaponId: WeaponId): void;
  /** WS-4 Phase 3 — apply the mining beam's light player-damage RAY: any player
   *  ship intersecting the miner→asteroid segment takes `perHitDamage`. A thin
   *  damage ray, NOT a physics collider (movement is unblocked). Absent ⇒ no-op. */
  damagePlayersInBeam?(minerId: string, fromX: number, fromY: number, toX: number, toY: number, perHitDamage: number): void;
  /** Live non-structure obstacles (asteroids) that block a connection's line of
   *  sight — same source the placement subsystem passes to autoConnectStructure.
   *  Used by the reconnect sweep so a retry honours current asteroid geometry.
   *  Optional: omitted ⇒ structures-only LOS (byte-identical). */
  getObstacles?: () => readonly GridObstacle[];
}

export interface GridPulseResult {
  /** Connection endpoint pairs that carried flow this pulse (for `grid_pulse`). */
  flashed: Array<[string, string]>;
  /** The flow material (Phase 3: always 'minerals'). */
  material: 'minerals';
}

export class StructureGridSubsystem {
  private readonly grid = new Grid();
  /** Structures whose component is currently held `powered` by stored battery
   *  charge despite a negative generation balance (rebuilt each `pulse()` by
   *  `processBatteryPower`). The single source of "battery-backed" truth read by
   *  `powerSummaryFor`, so the gates + the snapshot slice agree. */
  private readonly batteryRescued = new Set<string>();

  constructor(private readonly hooks: StructureGridHooks) {}

  /** Effective power for a structure, read by the turret/miner gates AND the
   *  snapshot slice. `netPower` is the raw generation balance (may be negative
   *  while batteries carry the load); `powered` is BATTERY-BACKED — a
   *  capital-connected deficit stays powered while its component's batteries
   *  hold enough charge to cover the per-pulse shortfall. With no batteries this
   *  is byte-identical to the raw grid summary. */
  powerSummaryFor(id: string): { netPower: number; powered: boolean } {
    const raw = this.grid.powerSummaryFor(id);
    if (raw.powered || !this.batteryRescued.has(id)) return raw;
    return { netPower: raw.netPower, powered: true };
  }

  /**
   * Phase 5 — aim + fire turrets. Called on the faster turret tick (NOT the
   * 1 Hz pulse) so turrets engage drones responsively. Each built + powered
   * turret targets the nearest drone in `weaponRange`, aims at it, and fires
   * (damage + beam) when its per-kind `fireRateMs` cooldown has elapsed.
   * Reads the live grid built by the most recent `pulse()` rebuild.
   */
  tickTurrets(nowMs: number): void {
    if (!this.hooks.findNearestDrone || !this.hooks.applyDamage) return;
    // WS-8 (R2.15) — generalised from the hard-coded 'turret' kind to ANY defence
    // turret, dispatched by its bound weapon's MODE: hitscan = the continuous
    // beam (existing); projectile = a dodgeable bolt (Bolt Turret); missile = a
    // homing missile (Missile Turret). `TURRET_TICK_MS` stays the targeting
    // cadence; the per-mode cooldown gates the actual shot.
    for (const rec of this.hooks.registry.all()) {
      if (!rec.isConstructed) continue;
      const kind = getStructureKind(rec.kind);
      const mountWeaponId = kind.mounts?.[0]?.weaponId;
      // A DEFENCE TURRET = a structure with a `weaponRange` AND a weaponised
      // mount. Data-driven (Open/Closed): auto-includes turret/laser_bolt_turret/
      // missile_turret and EXCLUDES the Miner (it has `miningRange` + a 'laser'
      // DRILL, driven by tickMiners — NOT a `weaponRange`).
      if (kind.weaponRange == null || !isWeaponId(mountWeaponId)) continue;
      if (!this.powerSummaryFor(rec.id).powered) {
        rec.turretTargetEntityId = undefined;
        continue;
      }
      const target = this.hooks.findNearestDrone(rec.x, rec.y, kind.weaponRange);
      rec.turretTargetEntityId = target?.entityId;
      if (!target) continue;
      const def = getWeapon(mountWeaponId);
      if (def.mode === 'hitscan') {
        // Continuous beam: a steady stream of small hits the client renders as
        // one beam (Issue 5). DPS-budget DoT on the beam cadence.
        const { cooldownMs, perHitDamage } = resolveTurretBeam(
          kind.weaponDamage ?? 0,
          kind.fireRateMs ?? 600,
          def.cooldownTicks,
        );
        if (nowMs - (rec.lastTurretFireMs ?? -Infinity) < cooldownMs) continue;
        rec.lastTurretFireMs = nowMs;
        this.hooks.applyDamage!(target.id, rec.id, perHitDamage);
        this.hooks.broadcastBeam?.(rec.id, rec.x, rec.y, target.x, target.y, target.id);
      } else if (def.mode === 'projectile') {
        // SHOT model: one dodgeable bolt per the KIND's `fireRateMs` (NOT the
        // weapon's rapid player cooldown — at 10 ticks that would be a firehose).
        // Damage lands on impact via the projectile sim; the client renders the
        // bolt off the `projectiles[]` slice (pose-authoritative).
        const cadence = kind.fireRateMs ?? 600;
        if (nowMs - (rec.lastTurretFireMs ?? -Infinity) < cadence) continue;
        rec.lastTurretFireMs = nowMs;
        this.fireTurretShot(rec, kind.radius, kind.weaponDamage, def, target.x, target.y);
      }
      // def.mode === 'missile' → WS-8 step 3 (needs the drones-only targeting
      // branch in isMissileTargetHostile before it can ship).
    }
  }

  /** WS-8 — spawn ONE bolt from a projectile turret toward (tx, ty), offset
   *  ahead of the barrel so it clears the firing structure's own collider (the
   *  projectile pipeline also skips the firing owner). Alloc-free (scalars). */
  private fireTurretShot(
    rec: StructureRecord,
    radius: number,
    weaponDamage: number | undefined,
    def: WeaponDef,
    tx: number,
    ty: number,
  ): void {
    if (!this.hooks.spawnProjectile || def.mode !== 'projectile') return;
    const dx = tx - rec.x;
    const dy = ty - rec.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ndx = dx / dist;
    const ndy = dy / dist;
    // Emerge from the barrel tip (clear the turret radius) — a static structure
    // has no velocity to inherit, so the bolt velocity is pure aim × speed.
    const muzzle = radius + 8;
    this.hooks.spawnProjectile(
      rec.id,
      rec.x + ndx * muzzle,
      rec.y + ndy * muzzle,
      ndx * def.speed,
      ndy * def.speed,
      weaponDamage ?? def.damage,
      def.radius,
      def.maxTicks,
      def.id,
    );
  }

  /** One grid heartbeat. `nowMs` stamps connection flashes. */
  pulse(nowMs: number): GridPulseResult {
    const registry = this.hooks.registry;
    // Reconnect sweep FIRST (playtest 2026-06-10 Issue 2 — "connectors break
    // between buildings, they just don't connect sometimes"). autoConnectStructure
    // runs ONCE at placement and never retries, so a structure placed before its
    // hub, or whose target hub was at capacity, stays stranded forever. Retry any
    // unconnected structure each pulse; addConnection dirties topology so the
    // rebuild below picks the new edge up THIS pulse.
    this.processReconnect();
    if (registry.topologyDirty) {
      this.grid.rebuild(buildGridNodes(registry), registry.adjacencyMap());
      registry.topologyDirty = false;
    }

    // Batteries charge/discharge BEFORE the power-gated steps so this pulse's
    // mining/turret gating sees the battery-backed power state.
    this.processBatteryPower();

    const flashed: Array<[string, string]> = [];
    this.processMining();
    this.processTransfer(nowMs, flashed);
    this.processConstruction(nowMs, flashed);
    this.processRepair(nowMs, flashed);
    this.processDeconstruction(nowMs, flashed);
    return { flashed, material: 'minerals' };
  }

  /**
   * Retry auto-connection for any structure with zero connections (playtest
   * 2026-06-10 Issue 2). Covers the temporal strandings placement-time
   * connection can't: hub placed AFTER its leaves, a target hub that was at
   * `maxConnections` when the leaf landed but has since freed a slot, an
   * asteroid that has since drifted out of the connecting segment. Capped per
   * pulse. Permanently-blocked geometry (collinear leaves) simply keeps
   * returning null cheaply. `autoConnectStructure` dirties topology on success.
   */
  private processReconnect(): void {
    const registry = this.hooks.registry;
    const obstacles = this.hooks.getObstacles?.();
    let attempts = 0;
    for (const rec of registry.all()) {
      if (attempts >= MAX_RECONNECT_ATTEMPTS_PER_PULSE) break;
      if (registry.connectionCount(rec.id) > 0) continue;
      attempts++;
      autoConnectStructure(registry, rec.id, obstacles);
    }
  }

  /**
   * Battery charge/discharge (batteries plan). Runs each pulse over every
   * capital-connected component:
   *   - a SURPLUS (`netPower > 0`) charges the component's batteries (even split
   *     across those not yet full, capped at `powerStorageCapacity`);
   *   - a DEFICIT (`netPower < 0`) is covered by discharging batteries IF their
   *     combined charge can meet the full per-pulse shortfall — the component
   *     then stays `powered` (battery-backed) and the shortfall is drained from
   *     storage; if they can't cover it, the component browns out (raw rule) and
   *     the batteries hold their charge.
   * Rebuilds `batteryRescued` from scratch each pulse. Power units are per-pulse
   * (same scale as the rest of the pulse economy — mining/construction amounts).
   */
  private processBatteryPower(): void {
    this.batteryRescued.clear();
    const capacity = getStructureKind('battery').powerStorageCapacity ?? 0;
    if (capacity <= 0) return;
    this.grid.forEachComponent((members, netPower, hasCapital) => {
      // A capital-less island is unpowered (raw rule) — batteries inert there.
      if (!hasCapital) return;
      if (netPower > 0) this.chargeComponentBatteries(members, capacity, netPower);
      else if (netPower < 0) this.dischargeComponentBatteries(members, -netPower);
    });
  }

  /** Charge a component's not-yet-full batteries with `surplus`, split evenly. */
  private chargeComponentBatteries(
    members: readonly string[],
    capacity: number,
    surplus: number,
  ): void {
    let count = 0;
    for (const id of members) {
      const rec = this.hooks.registry.get(id);
      if (rec && rec.kind === 'battery' && rec.storedPower < capacity) count++;
    }
    if (count === 0) return;
    const share = surplus / count;
    for (const id of members) {
      const rec = this.hooks.registry.get(id);
      if (!rec || rec.kind !== 'battery' || rec.storedPower >= capacity) continue;
      rec.storedPower = chargeStep(rec.storedPower, capacity, share).stored;
    }
  }

  /** Discharge a component's batteries to cover a per-pulse `deficit` — but only
   *  when their combined charge can meet it in full. Marks the whole component
   *  battery-backed (`batteryRescued`) for this pulse. */
  private dischargeComponentBatteries(members: readonly string[], deficit: number): void {
    let total = 0;
    for (const id of members) {
      const rec = this.hooks.registry.get(id);
      if (rec && rec.kind === 'battery') total += rec.storedPower;
    }
    if (total < deficit) return; // can't sustain the load → brownout, hold charge
    for (const id of members) this.batteryRescued.add(id);
    let remaining = deficit;
    for (const id of members) {
      if (remaining <= 0) break;
      const rec = this.hooks.registry.get(id);
      if (!rec || rec.kind !== 'battery' || rec.storedPower <= 0) continue;
      const r = dischargeStep(rec.storedPower, remaining);
      rec.storedPower = r.stored;
      remaining -= r.supplied;
    }
  }

  /** Total stored battery charge in the connected component containing `id`
   *  (shield-fence plan — the wall's depletable buffer). 0 if `id` is unbuilt. */
  componentBatteryCharge(id: string): number {
    let total = 0;
    for (const mid of this.grid.componentMembers(id)) {
      const rec = this.hooks.registry.get(mid);
      if (rec && rec.kind === 'battery') total += rec.storedPower;
    }
    return total;
  }

  /** Drain up to `amount` from the component's batteries (a shield-wall hit).
   *  Returns the amount actually drained. */
  drainComponentBatteries(id: string, amount: number): number {
    let remaining = amount;
    for (const mid of this.grid.componentMembers(id)) {
      if (remaining <= 0) break;
      const rec = this.hooks.registry.get(mid);
      if (!rec || rec.kind !== 'battery' || rec.storedPower <= 0) continue;
      const r = drainPower(rec.storedPower, remaining);
      rec.storedPower = r.stored;
      remaining -= r.drained;
    }
    return amount - remaining;
  }

  /** Phase 4 — each built + powered Miner extracts `miningRate` from the
   *  nearest in-range asteroid into its local buffer (capped by storage). */
  private processMining(): void {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'miner' || !rec.isConstructed) continue;
      if (!this.powerSummaryFor(rec.id).powered) {
        this.clearMiningTarget(rec);
        continue;
      }
      const kind = getStructureKind('miner');
      // findNearestAsteroid SKIPS exhausted rocks (resources<=0), so an
      // exhausted asteroid is never returned and the miner auto-retargets to a
      // fresh in-range rock (or clears its target → the beam stops).
      const target = this.hooks.findNearestAsteroid(rec.x, rec.y, kind.miningRange ?? 0);
      if (!target) { this.clearMiningTarget(rec); continue; }
      // Cache the target + its (static) pose so the faster mining-beam tick
      // (tickMiners) can broadcast the beam endpoint without re-scanning. Build
      // the `swarm-<eid>` wire id ONLY when the target rock CHANGES, so the
      // steady-state (mining one rock) never allocates a template string — the
      // ~5 Hz tickMiners reads the cached `miningTargetWireId` (invariant #14).
      if (rec.miningTargetEntityId !== target.entityId) {
        rec.miningTargetWireId = 'swarm-' + target.entityId;
      }
      rec.miningTargetEntityId = target.entityId;
      rec.miningTargetX = target.x;
      rec.miningTargetY = target.y;
      // WS-4 / R2.27 — draw from the asteroid's FINITE resource pool, capped by
      // the miner's per-pulse rate AND its remaining storage (don't burn finite
      // ore into full storage). drawAsteroidResources decrements the pool and
      // returns the amount actually mined; absent hook ⇒ flat rate (pre-WS-4 /
      // unit-harness fallback). Combat never reaches this hook (ADR boundary).
      const want = Math.min(kind.miningRate ?? 0, kind.storageCapacity - rec.minerals);
      const drawn = this.hooks.drawAsteroidResources
        ? this.hooks.drawAsteroidResources(target.entityId, want)
        : want;
      rec.minerals = Math.min(kind.storageCapacity, rec.minerals + drawn);
    }
  }

  /** Clear a Miner's target + cached pose (unpowered / no in-range rock) so the
   *  mining beam stops on the next tick. */
  private clearMiningTarget(rec: StructureRecord): void {
    rec.miningTargetEntityId = undefined;
    rec.miningTargetX = undefined;
    rec.miningTargetY = undefined;
    rec.miningTargetWireId = undefined;
  }

  /**
   * WS-4 Phase 2 (R2.27) — broadcast each built+powered Miner's MINING BEAM
   * (`laser_fired`, mountId `drill`) from the miner to its cached target asteroid
   * pose, on the `MINING_BEAM_CADENCE_MS` gate. Mirrors `tickTurrets`; ticked
   * from the same `structureTurretTick` timer (faster than the 1 Hz pulse so the
   * CONTINUOUS beam doesn't flicker under the client's ~400 ms laser TTL).
   *
   * The drill mount is NOT slewed: a structure shooter's beam renders from the
   * WIRE endpoints (miner → asteroid), so a mount-angle slew would have zero
   * render effect AND would add a second mount-angle ownership site (Invariant
   * #12). The endpoint pose is the static asteroid pose cached by `processMining`.
   * Allocation-free (invariant #14): per-record scalar cadence compare + the
   * target's `swarm-<eid>` wire id is READ from `rec.miningTargetWireId` (built
   * by `processMining` only when the target rock changes), so a steady mining
   * broadcast allocates nothing.
   */
  tickMiners(nowMs: number): void {
    if (!this.hooks.broadcastBeam) return;
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'miner' || !rec.isConstructed) continue;
      if (rec.miningTargetEntityId === undefined || rec.miningTargetX === undefined || rec.miningTargetY === undefined) continue;
      if (rec.miningTargetWireId === undefined) continue;
      if (!this.powerSummaryFor(rec.id).powered) continue;
      if (nowMs - (rec.lastMiningBeamMs ?? -Infinity) < MINING_BEAM_CADENCE_MS) continue;
      rec.lastMiningBeamMs = nowMs;
      this.hooks.broadcastBeam(
        rec.id, rec.x, rec.y, rec.miningTargetX, rec.miningTargetY,
        rec.miningTargetWireId, 'drill',
      );
      // WS-4 Phase 3 — light player-damage ray along the same beam. Per-broadcast
      // chip = DPS × cadence so the effective DPS is constant regardless of the
      // beam cadence (the resolveTurretBeam-style DPS-preserving model).
      this.hooks.damagePlayersInBeam?.(
        rec.id, rec.x, rec.y, rec.miningTargetX, rec.miningTargetY,
        MINING_BEAM_PLAYER_DPS * (MINING_BEAM_CADENCE_MS / 1000),
      );
    }
  }

  /** Phase 4 — haul buffered minerals from non-Capital structures toward a
   *  Capital with free storage, along the A* route (capped by throughput). */
  private processTransfer(nowMs: number, flashed: Array<[string, string]>): void {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind === 'capital' || !rec.isConstructed || rec.minerals <= 0) continue;
      const dest = this.findCapitalWithSpace(rec.id);
      if (!dest) continue;
      const capStorage = getStructureKind(dest.capital.kind).storageCapacity;
      const space = capStorage - dest.capital.minerals;
      if (space <= 0) continue;
      const move = Math.min(rec.minerals, CONNECTION_THROUGHPUT, space);
      if (move <= 0) continue;
      rec.minerals -= move;
      dest.capital.minerals += move;
      this.flashRoute(dest.route, nowMs, flashed);
    }
  }

  private findCapitalWithSpace(sourceId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || !rec.isConstructed) continue;
      if (rec.minerals >= getStructureKind(rec.kind).storageCapacity) continue;
      const route = this.grid.route(sourceId, rec.id);
      if (route) return { capital: rec, route };
    }
    return null;
  }

  /** Find a built Capital with minerals that can route to `targetId`. */
  private findStorageRoute(targetId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || !rec.isConstructed || rec.minerals <= 0) continue;
      const route = this.grid.route(rec.id, targetId);
      if (route) return { capital: rec, route };
    }
    return null;
  }

  private flashRoute(route: readonly string[], nowMs: number, flashed: Array<[string, string]>): void {
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      const conn = this.findConnection(a, b);
      if (conn) {
        conn.flash(nowMs, 'minerals');
        flashed.push([a, b]);
      }
    }
  }

  private findConnection(aId: string, bId: string): Connection | null {
    for (const c of this.hooks.registry.connectionsOf(aId)) {
      if (c.getOtherNode(aId) === bId) return c;
    }
    return null;
  }

  private processConstruction(nowMs: number, flashed: Array<[string, string]>): void {
    for (const bp of this.hooks.registry.all()) {
      if (bp.isConstructed || bp.isDeconstructing) continue;
      const source = this.findStorageRoute(bp.id);
      if (!source) continue; // unreachable OR no minerals → pause
      const amount = Math.min(CONSTRUCTION_PULSE_AMOUNT, source.capital.minerals);
      if (amount <= 0) continue;
      source.capital.minerals -= amount;
      bp.constructionProgress += amount;
      this.flashRoute(source.route, nowMs, flashed);
      if (bp.constructionProgress >= bp.constructionCost) {
        bp.constructionProgress = bp.constructionCost;
        bp.isConstructed = true;
        this.hooks.setHealth(bp.id, getStructureKind(bp.kind).maxHealth);
        this.hooks.registry.topologyDirty = true; // it now relays
      }
    }
  }

  private processRepair(nowMs: number, flashed: Array<[string, string]>): void {
    for (const rec of this.hooks.registry.all()) {
      if (!rec.isConstructed || rec.isDeconstructing) continue;
      const max = getStructureKind(rec.kind).maxHealth;
      const hp = this.hooks.getHealth(rec.id);
      if (hp >= max) continue;
      const source = this.findStorageRoute(rec.id);
      if (!source) continue;
      const spend = Math.min(REPAIR_PULSE_AMOUNT, source.capital.minerals);
      if (spend <= 0) continue;
      const hpGain = Math.min(max - hp, spend / REPAIR_COST_PER_HP);
      const actualSpend = hpGain * REPAIR_COST_PER_HP;
      source.capital.minerals -= actualSpend;
      this.hooks.setHealth(rec.id, hp + hpGain);
      this.flashRoute(source.route, nowMs, flashed);
    }
  }

  private processDeconstruction(nowMs: number, flashed: Array<[string, string]>): void {
    // Snapshot the list — we may remove entries mid-iteration.
    const decon: StructureRecord[] = [];
    for (const rec of this.hooks.registry.all()) {
      if (rec.isDeconstructing) decon.push(rec);
    }
    for (const rec of decon) {
      const reclaim = Math.min(DECONSTRUCTION_RATE_KG, rec.constructionProgress);
      rec.constructionProgress -= reclaim;
      // Return reclaimed minerals to a connected Capital (capped by capacity).
      if (reclaim > 0) {
        const source = this.returnRoute(rec.id);
        if (source) {
          const cap = getStructureKind(source.capital.kind).storageCapacity;
          source.capital.minerals = Math.min(cap, source.capital.minerals + reclaim);
          this.flashRoute(source.route, nowMs, flashed);
        }
      }
      if (rec.constructionProgress <= 0) {
        this.hooks.despawn(rec.id);
        this.hooks.registry.remove(rec.id);
      }
    }
  }

  /** A route to ANY built Capital (regardless of its mineral level) for
   *  returning reclaimed minerals. */
  private returnRoute(targetId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || !rec.isConstructed) continue;
      const route = this.grid.route(rec.id, targetId);
      if (route) return { capital: rec, route };
    }
    return null;
  }
}
