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
import {
  canUpgradeStructure,
  effectiveStructureMaxHealth,
  structureLevelFactor,
  structureUpgradeCost,
} from '../../core/leveling/structureLevel.js';
import { getWeapon, isWeaponId, type WeaponDef, type WeaponId, type MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
import { MINING_BEAM_PLAYER_DPS, resolveMiningBeamEndpoint, type MiningBeamObstacle } from '../../core/combat/miningBeamHazard.js';
import { Grid, type GridObstacle } from '../../core/structures/Grid.js';
import { chargeStep, dischargeStep, drainPower } from '../../core/structures/batteryPower.js';
import type { Connection, FlowMaterial } from '../../core/structures/Connection.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_MIN_HP_QUANTUM,
  REPAIR_COST_PER_HP,
  DECONSTRUCTION_RATE_KG,
  CONNECTION_THROUGHPUT,
  MINING_BEAM_CADENCE_MS,
  TRANSFER_PULSE_MS,
} from '../../core/structures/structureGridConstants.js';
import { autoConnectStructure, buildGridNodes } from './structureGridView.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** Cap on reconnect attempts per pulse so a sector full of permanently-stranded
 *  structures (e.g. collinear-blocked leaves) can't make the 1 Hz pulse rescan
 *  the whole registry every beat. Bounded work; the next pulse retries the rest. */
const MAX_RECONNECT_ATTEMPTS_PER_PULSE = 8;

/** Shared empty obstacle list for the mining-beam surface clip (the building-block
 *  leg is deferred — see `resolveMiningClip`). Module const ⇒ no per-pulse alloc. */
const EMPTY_MINING_OBSTACLES: readonly MiningBeamObstacle[] = [];

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
  findNearestAsteroid(x: number, y: number, range: number): { entityId: number; x: number; y: number; radius: number } | null;
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
  /** WS-8 (R2.15) — launch a homing MISSILE from a Missile Turret toward its
   *  target (the player/AI fire path's `spawnServerMissile`; ownerId = the
   *  turret's `pstruct-` id, which the missile targeting restricts to drones).
   *  `dirX`/`dirY` are the UNIT aim direction. Absent ⇒ no missile. */
  spawnMissile?(shooterId: string, x: number, y: number, dirX: number, dirY: number, def: MissileWeaponDef): void;
  /** WS-4 Phase 3 — apply the mining beam's light player-damage RAY: any player
   *  ship intersecting the miner→asteroid segment takes `perHitDamage`. A thin
   *  damage ray, NOT a physics collider (movement is unblocked). Absent ⇒ no-op. */
  damagePlayersInBeam?(minerId: string, fromX: number, fromY: number, toX: number, toY: number, perHitDamage: number): void;
  /** Live non-structure obstacles (asteroids) that block a connection's line of
   *  sight — same source the placement subsystem passes to autoConnectStructure.
   *  Used by the reconnect sweep so a retry honours current asteroid geometry.
   *  Optional: omitted ⇒ structures-only LOS (byte-identical). */
  getObstacles?: () => readonly GridObstacle[];
  /** Gameplay audit — a blueprint finished construction this pulse. The room
   *  supplies the closure (it owns the sectorKey). Off the 60 Hz loop (1 Hz
   *  pulse). Optional ⇒ no-op in the unit harness. */
  onConstructed?: (owner: string, kind: string) => void;
}

export interface GridPulseResult {
  /** Connection endpoints + the flow MATERIAL that crossed them this pulse (for
   *  `grid_pulse`). WS-D (#12) — each edge is tagged with its own material
   *  (`repair` / `minerals` / `construction`) so the client tints per-edge: a
   *  repair route greens, a haul route oranges, a build route cyans, all in the
   *  SAME pulse. Idle edges are simply absent (the client renders muted-blue). */
  flashed: Array<[string, string, FlowMaterial]>;
  /** The DOMINANT pulse material — kept for the back-compat single-material wire
   *  field; `'minerals'` when anything mineral-ish flowed, else the first flashed
   *  edge's material. Per-edge material on `flashed` is the authoritative tint. */
  material: FlowMaterial;
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
      // Phase 4 WS-B4 — a leveled turret targets FARTHER + hits HARDER. The
      // single scalar factor (alloc-free) scales the kind's catalogue range +
      // damage; level 1 is the identity (byte-identical to pre-WS-B4).
      const lvlMul = structureLevelFactor(rec.level);
      const range = kind.weaponRange * lvlMul;
      const damage = (kind.weaponDamage ?? 0) * lvlMul;
      const target = this.hooks.findNearestDrone(rec.x, rec.y, range);
      rec.turretTargetEntityId = target?.entityId;
      if (!target) continue;
      const def = getWeapon(mountWeaponId);
      if (def.mode === 'hitscan') {
        // Continuous beam: a steady stream of small hits the client renders as
        // one beam (Issue 5). DPS-budget DoT on the beam cadence.
        const { cooldownMs, perHitDamage } = resolveTurretBeam(
          damage,
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
        this.fireTurretShot(rec, kind.radius, damage, def, target.x, target.y);
      } else if (def.mode === 'missile') {
        // SHOT model: one homing missile per the kind's `fireRateMs` (a slow
        // salvo). The missile homes via MissileSimulation — restricted to DRONES
        // for a pstruct- owner (SectorRoom.isMissileTargetHostile) — and renders
        // off the `missiles[]` slice. Its splash CAN hit the owner's own base
        // (realistic, by user choice — no friendly-structure skip).
        const cadence = kind.fireRateMs ?? 1500;
        if (nowMs - (rec.lastTurretFireMs ?? -Infinity) < cadence) continue;
        rec.lastTurretFireMs = nowMs;
        this.fireTurretMissile(rec, kind.radius, def, target.x, target.y);
      }
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

  /** WS-8 — launch ONE homing missile from a missile turret toward (tx, ty),
   *  offset ahead of the launcher. `dirX`/`dirY` are the UNIT aim direction (the
   *  missile sim owns speed). Alloc-free (scalars). */
  private fireTurretMissile(
    rec: StructureRecord,
    radius: number,
    def: WeaponDef,
    tx: number,
    ty: number,
  ): void {
    if (!this.hooks.spawnMissile || def.mode !== 'missile') return;
    const dx = tx - rec.x;
    const dy = ty - rec.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ndx = dx / dist;
    const ndy = dy / dist;
    const muzzle = radius + 8;
    this.hooks.spawnMissile(rec.id, rec.x + ndx * muzzle, rec.y + ndy * muzzle, ndx, ndy, def);
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

    const flashed: Array<[string, string, FlowMaterial]> = [];
    this.processMining();
    this.processTransfer(nowMs, flashed);
    this.processConstruction(nowMs, flashed);
    this.processRepair(nowMs, flashed);
    this.processDeconstruction(nowMs, flashed);
    // Dominant pulse material (back-compat single field): prefer 'minerals' when
    // any haul/reclaim flowed (the common steady-state), else the first edge's.
    let material: FlowMaterial = 'minerals';
    if (flashed.length > 0) {
      material = flashed[0]![2];
      for (let i = 0; i < flashed.length; i++) {
        if (flashed[i]![2] === 'minerals') { material = 'minerals'; break; }
      }
    }
    return { flashed, material };
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
      // Phase 5 — a structure that has EVER connected and is now at 0 was either
      // deliberately CLEARED by the player or ORPHANED by its hub's destruction.
      // Leave it orphaned until the player manually reconnects (the sweep used to
      // re-wire it instantly, making the Clear button pointless). Only NEVER-
      // connected placements (temporal strandings, Issue 2) auto-connect here.
      if (registry.hasEverConnected(rec.id)) continue;
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
      rec.miningTargetRadius = target.radius;
      // P1b — resolve the beam endpoint: clip at the asteroid SURFACE so the beam
      // cuts at the point of impact instead of plunging to the centre.
      this.resolveMiningClip(rec);
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
    rec.miningTargetRadius = undefined;
    rec.miningClipX = undefined;
    rec.miningClipY = undefined;
    rec.miningBeamBlocked = undefined;
    rec.miningTargetWireId = undefined;
  }

  /**
   * P1b — resolve a Miner's mining-beam endpoint (`miningClipX/Y`) + whether it is
   * blocked (`miningBeamBlocked`). The beam, like a real laser, stops at the first
   * solid thing it meets along the miner→asteroid line:
   *   - default: the asteroid SURFACE (centre − radius), so it visibly CUTS at the
   *     point of impact instead of plunging to the centre;
   *   - sooner: any OTHER built structure whose collider the ray enters first — the
   *     beam stops at that building (it no longer shoots through), and a blocked
   *     beam mines nothing.
   * Pure scalar `rayHitsSphere` per other structure; runs on the 1 Hz pulse (off
   * the 60 Hz tick), so the linear scan over the small structure set is fine.
   */
  private resolveMiningClip(rec: StructureRecord): void {
    // Cut at the asteroid SURFACE (P1b). The building-block leg of the same
    // complaint ("don't shoot THROUGH buildings") is intentionally NOT wired here
    // yet: `resolveMiningBeamEndpoint` supports + unit-tests the obstacle clip, but
    // a miner's OWN base structures sit near its beam line, so a naive block stops
    // legitimate mining — wiring it needs an own-faction-exclusion policy. Pass NO
    // obstacles for now (surface clip only). `EMPTY_OBSTACLES` avoids a per-pulse
    // alloc.
    const result = resolveMiningBeamEndpoint(
      rec.x, rec.y,
      rec.miningTargetX ?? rec.x, rec.miningTargetY ?? rec.y, rec.miningTargetRadius ?? 0,
      EMPTY_MINING_OBSTACLES,
    );
    rec.miningClipX = result.x;
    rec.miningClipY = result.y;
    rec.miningBeamBlocked = result.blocked;
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
      // P1b — broadcast to the CLIPPED endpoint (asteroid surface, or a structure
      // blocking the line of sight) so the beam cuts at the point of impact instead
      // of plunging through the rock / through buildings. Falls back to the centre
      // before the first pulse resolves the clip.
      const toX = rec.miningClipX ?? rec.miningTargetX;
      const toY = rec.miningClipY ?? rec.miningTargetY;
      this.hooks.broadcastBeam(rec.id, rec.x, rec.y, toX, toY, rec.miningTargetWireId, 'drill');
      // WS-4 Phase 3 — light player-damage ray along the same (clipped) beam.
      // Per-broadcast chip = DPS × cadence so the effective DPS is constant
      // regardless of the beam cadence (the resolveTurretBeam-style DPS model).
      this.hooks.damagePlayersInBeam?.(
        rec.id, rec.x, rec.y, toX, toY,
        MINING_BEAM_PLAYER_DPS * (MINING_BEAM_CADENCE_MS / 1000),
      );
    }
  }

  /** Phase 4 — haul buffered minerals from non-Capital structures toward a
   *  Capital with free storage, along the A* route (capped by throughput). */
  private processTransfer(nowMs: number, flashed: Array<[string, string, FlowMaterial]>): void {
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
      this.flashRoute(dest.route, nowMs, flashed, 'minerals');
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

  /**
   * Estimate ms-to-completion for a blueprint at the steady delivery rate
   * (`CONSTRUCTION_PULSE_AMOUNT` per `TRANSFER_PULSE_MS`), ASSUMING resources
   * are available — the doc's "the building time is independent of [the supply
   * pulse], assuming no shortage of resources." Returns `null` when there's
   * nothing to time (already built / zero-cost Capital) OR the build is STALLED
   * (no storage route with minerals) so the client freezes the bar + shows a
   * paused timer. Drives the smooth client build bar (issue 1) + the in-world
   * ETA countdown (issue 2). Computed in the 1 Hz slice rebuild, never the
   * 60 Hz tick — the division is free.
   */
  estimateBuildEtaMs(rec: StructureRecord): number | null {
    if (rec.isConstructed || rec.constructionCost <= 0) return null;
    if (!this.findStorageRoute(rec.id)) return null; // unreachable / dry → paused
    const remaining = Math.max(0, rec.constructionCost - rec.constructionProgress);
    const ratePerMs = CONSTRUCTION_PULSE_AMOUNT / TRANSFER_PULSE_MS;
    return ratePerMs > 0 ? remaining / ratePerMs : null;
  }

  /**
   * Phase-1 issue 6 — player-triggered "reconnect to the nearest structure(s)".
   * Re-runs the SAME obstacle-aware auto-connect the placement + 1 Hz reconnect
   * sweep use, so a stranded structure (its hub was removed, or it was placed
   * before its hub) re-wires to the nearest legal in-range hub(s). Additive
   * (never severs); `autoConnectStructure` dirties topology on success. Returns
   * false for an unknown id.
   */
  reconnect(id: string): boolean {
    if (!this.hooks.registry.get(id)) return false;
    autoConnectStructure(this.hooks.registry, id, this.hooks.getObstacles?.());
    return true;
  }

  /**
   * Phase-1 issue 6 — player-triggered "clear all connections" (chiefly for a
   * Connector). Severs every connection touching the structure; the registry
   * dirties topology. Returns false for an unknown id.
   */
  clearConnections(id: string): boolean {
    if (!this.hooks.registry.get(id)) return false;
    this.hooks.registry.disconnect(id);
    return true;
  }

  /**
   * Phase 4 WS-B4 — player-triggered "upgrade this structure": start a PAID
   * build phase that, on completion (handled in `processConstruction`),
   * increments the structure's level and applies the per-level stat grant.
   *
   * Validates: the structure exists, is fully BUILT (a half-built blueprint
   * can't be upgraded), is NOT deconstructing, and is below the level cap. A
   * structure already mid-upgrade (its `upgradeTargetLevel` is set) is rejected.
   * Owner-gating is the CALLER's responsibility (the room resolves owner before
   * calling this, like `reconnect`/`clearConnections`).
   *
   * The COST is `structureUpgradeCost(constructionCost, level)` (escalating per
   * level). The cost is NOT pre-charged here — it's drained DURING the build by
   * the construction pulse (the SAME machinery the initial build uses), so an
   * upgrade started against an empty bank simply waits until minerals arrive,
   * exactly like a fresh blueprint. We reset `constructionProgress` to 0 and set
   * `constructionCost` to the upgrade cost so the pulse fills toward it.
   *
   * Returns true if an upgrade build phase was started, false otherwise (unknown
   * / unbuilt / deconstructing / capped / already upgrading).
   */
  upgradeStructure(id: string): boolean {
    const rec = this.hooks.registry.get(id);
    if (!rec) return false;
    if (!rec.isConstructed || rec.isDeconstructing) return false;
    if (rec.upgradeTargetLevel !== undefined) return false; // already upgrading
    if (!canUpgradeStructure(rec.level)) return false; // at the cap
    const baseCost = getStructureKind(rec.kind).constructionCost;
    const cost = structureUpgradeCost(baseCost, rec.level);
    // Review must-fix #2 (2026-06-20): the Capital's `constructionCost` is 0, so
    // its upgrade `cost` is 0 — a BALANCE oddity (a free capital upgrade,
    // contradicts D14 "costs resources"; recorded as a follow-up, NOT this fix).
    // It does NOT mean the build "completes on the first pulse": `process-
    // Construction` reaches the FUNDING gate (`findStorageRoute`) BEFORE the
    // `constructionProgress >= constructionCost` completion check, so the upgrade
    // only completes once the capital is routable as a funder. That funding is
    // exactly why a mid-upgrade Capital must stay funding-capable + grid-
    // traversable — see `findStorageRoute` + `structureToGridNode`. The upgrade
    // is gated on `canUpgradeStructure`, not a non-zero cost.
    rec.isConstructed = false;
    rec.constructionProgress = 0;
    rec.constructionCost = cost;
    rec.upgradeTargetLevel = rec.level + 1;
    // A node mid-upgrade is inert (the `isConstructed` gate in structureGridView
    // already projects 0 power for an unbuilt node), so the topology must rebuild
    // so the grid stops counting its power/relaying through it while it rebuilds.
    this.hooks.registry.topologyDirty = true;
    return true;
  }

  /** Find a Capital with minerals that can route to `targetId`.
   *
   *  Review must-fix #2 (2026-06-20, plan effervescent-umbrella): a Capital that
   *  is MID-UPGRADE (`upgradeTargetLevel !== undefined`) STILL counts as a funder.
   *  The Capital is the grid's ONLY mineral bank, and an Upgrade flips its
   *  `isConstructed` false to run a visible re-build (`upgradeStructure`). If the
   *  plain `!rec.isConstructed` exclusion stood, upgrading the Capital would brick
   *  the ENTIRE grid: `findStorageRoute` would return null for EVERY blueprint
   *  (including the capital itself), so `processConstruction` `continue`s before
   *  the completion check — the capital's own upgrade NEVER completes (permanent
   *  blueprint) AND every other structure's construction/upgrade/repair stalls for
   *  the duration. So a mid-upgrade Capital remains funding-capable; it is an
   *  already-operational bank being re-built, not a fresh blueprint. Its
   *  grid-traversability as a route SOURCE is preserved by the matching
   *  `structureToGridNode` projection (a mid-upgrade capital projects
   *  `isConstructed: true` so `Grid.route` accepts it as source + relay). */
  private findStorageRoute(targetId: string): { capital: StructureRecord; route: readonly string[] } | null {
    for (const rec of this.hooks.registry.all()) {
      if (rec.kind !== 'capital' || rec.minerals <= 0) continue;
      const fundingCapable = rec.isConstructed || rec.upgradeTargetLevel !== undefined;
      if (!fundingCapable) continue;
      const route = this.grid.route(rec.id, targetId);
      if (route) return { capital: rec, route };
    }
    return null;
  }

  private flashRoute(
    route: readonly string[],
    nowMs: number,
    flashed: Array<[string, string, FlowMaterial]>,
    material: FlowMaterial,
  ): void {
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      const conn = this.findConnection(a, b);
      if (conn) {
        conn.flash(nowMs, material);
        flashed.push([a, b, material]);
      }
    }
  }

  private findConnection(aId: string, bId: string): Connection | null {
    for (const c of this.hooks.registry.connectionsOf(aId)) {
      if (c.getOtherNode(aId) === bId) return c;
    }
    return null;
  }

  private processConstruction(nowMs: number, flashed: Array<[string, string, FlowMaterial]>): void {
    for (const bp of this.hooks.registry.all()) {
      if (bp.isConstructed || bp.isDeconstructing) continue;
      const source = this.findStorageRoute(bp.id);
      if (!source) continue; // unreachable OR no minerals → pause
      const amount = Math.min(CONSTRUCTION_PULSE_AMOUNT, source.capital.minerals);
      if (amount <= 0) continue;
      source.capital.minerals -= amount;
      bp.constructionProgress += amount;
      this.flashRoute(source.route, nowMs, flashed, 'construction');
      if (bp.constructionProgress >= bp.constructionCost) {
        bp.constructionProgress = bp.constructionCost;
        bp.isConstructed = true;
        // Phase 4 WS-B4 — an UPGRADE build (upgradeTargetLevel set) increments
        // the level on completion + applies the per-level stat grant; a normal
        // (initial) build leaves the level untouched. The HP seed uses the
        // LEVELED effective max so a leveled structure builds up to its full
        // (boosted) hull. After an upgrade, restore `constructionCost` to the
        // kind's base so a SUBSEQUENT upgrade re-derives the next cost cleanly.
        if (bp.upgradeTargetLevel !== undefined) {
          bp.level = bp.upgradeTargetLevel;
          bp.upgradeTargetLevel = undefined;
          bp.constructionCost = getStructureKind(bp.kind).constructionCost;
        }
        this.hooks.setHealth(bp.id, effectiveStructureMaxHealth(getStructureKind(bp.kind).maxHealth, bp.level));
        this.hooks.registry.topologyDirty = true; // it now relays
        this.hooks.onConstructed?.(bp.owner, bp.kind);
      }
    }
  }

  private processRepair(nowMs: number, flashed: Array<[string, string, FlowMaterial]>): void {
    for (const rec of this.hooks.registry.all()) {
      if (!rec.isConstructed || rec.isDeconstructing) continue;
      const max = getStructureKind(rec.kind).maxHealth;
      const hp = this.hooks.getHealth(rec.id);
      // Campaign 4.3 (review A8) — repair in MEANINGFUL QUANTA. A structure
      // under sustained sub-quantum chip damage used to find `hp < max` + a
      // funded route EVERY 1 Hz pulse, so its repair route flashed forever
      // ("power lines STILL lit up constantly to defensive turrets"). The
      // deficit now accumulates silently until a whole quantum can land; the
      // route flashes on the quantum and reads idle between. Also covers the
      // float-dust case (hp a rounding-sliver below max never re-flashes).
      if (max - hp < REPAIR_MIN_HP_QUANTUM) continue;
      const source = this.findStorageRoute(rec.id);
      if (!source) continue;
      const spend = Math.min(REPAIR_PULSE_AMOUNT, source.capital.minerals);
      if (spend <= 0) continue;
      const hpGain = Math.min(max - hp, spend / REPAIR_COST_PER_HP);
      // A starved bank that can only afford sub-quantum dust waits for a
      // fuller one — no dust-heal, no flash (the WS-D stalled case, tightened
      // from `> 0` to the quantum).
      if (hpGain < REPAIR_MIN_HP_QUANTUM) continue;
      // The route is tagged 'repair' so the client tints it green (healing),
      // distinct from the orange mineral haul off the same Capital (WS-D #12).
      const actualSpend = hpGain * REPAIR_COST_PER_HP;
      source.capital.minerals -= actualSpend;
      this.hooks.setHealth(rec.id, hp + hpGain);
      this.flashRoute(source.route, nowMs, flashed, 'repair');
    }
  }

  private processDeconstruction(nowMs: number, flashed: Array<[string, string, FlowMaterial]>): void {
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
          this.flashRoute(source.route, nowMs, flashed, 'minerals');
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
