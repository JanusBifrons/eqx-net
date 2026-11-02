/**
 * Proximity mines laid by Mine Layers (plan soft-leaping-truffle v3, P2d
 * follow-up). Decision logic over injected hooks, ticked with the 10 Hz
 * structure tick (`SectorRoom.structureTurretTick`), unit-tested on its own.
 *
 * - A built, powered Mine Layer below `MINES_PER_LAYER` lays one mine every
 *   `MINE_LAY_INTERVAL_MS`, on a ring around itself at a clear spot, paying
 *   from the same magazine turrets use (`rec.ammo`, refilled from one munition
 *   for `AMMO_SHOTS_PER_UNIT.mine_layer` mines). Out of munitions ⇒ `noAmmo`.
 * - An armed mine detonates on the first target the `findHostile` hook returns
 *   (the owner's turret-targeting rule), then leaves the world.
 * - A mine whose layer is gone (destroyed, deconstructed) leaves with it.
 *
 * Mines are not persisted: a restart lays them again.
 */
import { AMMO_SHOTS_PER_UNIT } from '../../shared-types/ammo.js';
import {
  MINES_PER_LAYER,
  MINE_ARM_MS,
  MINE_LAY_INTERVAL_MS,
  MINE_RING_MAX,
  MINE_RING_MIN,
  MINE_TRIGGER_RANGE,
} from '../../shared-types/mines.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

export interface MineRecord {
  id: string;
  layerId: string;
  owner: string;
  x: number;
  y: number;
  armedAtMs: number;
}

export interface MineTarget {
  id: string;
  x: number;
  y: number;
}

export interface MineFieldDeps {
  registry: StructureRegistry;
  powered(id: string): boolean;
  /** Take one unit of munitions from the layer owner's network storage. Absent
   *  ⇒ unlimited (unit harnesses). */
  takeMunition?(rec: StructureRecord): boolean;
  /** Is (x, y) clear for a mine (structures, asteroids, other mines)? */
  isClear(x: number, y: number): boolean;
  /** The nearest target hostile to `owner` within `range` of (x, y). */
  findHostile(x: number, y: number, range: number, owner: string): MineTarget | null;
  /** A mine went off on `target`: apply the damage and show the blast. */
  detonate(mine: MineRecord, target: MineTarget): void;
  onLaid(mine: MineRecord): void;
  onRemoved(mine: MineRecord): void;
  /** Active power: full draw while laying, the idle trickle once full. */
  setActive?(rec: StructureRecord, active: boolean): void;
}

/** Golden angle: successive mines of one layer spread evenly round the ring. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Spots tried per lay before waiting for the next interval. */
const LAY_TRIES = 8;

export class MineFieldSubsystem {
  readonly mines = new Map<string, MineRecord>();
  private counter = 0;
  /** Per layer: next lay time and how many mines it has laid (ring position). */
  private readonly nextLayAt = new Map<string, number>();
  private readonly laidCount = new Map<string, number>();
  /** Per-tick scratch: live mines per layer. */
  private readonly perLayer = new Map<string, number>();

  constructor(private readonly d: MineFieldDeps) {}

  tick(nowMs: number): void {
    const reg = this.d.registry;
    const perLayer = this.perLayer;
    perLayer.clear();
    // 1. Trigger armed mines; drop mines whose layer is gone.
    for (const [id, m] of this.mines) {
      const layer = reg.get(m.layerId);
      if (layer === undefined) {
        this.remove(id, m);
        continue;
      }
      if (nowMs >= m.armedAtMs) {
        const t = this.d.findHostile(m.x, m.y, MINE_TRIGGER_RANGE, m.owner);
        if (t !== null) {
          this.d.detonate(m, t);
          this.remove(id, m);
          continue;
        }
      }
      perLayer.set(m.layerId, (perLayer.get(m.layerId) ?? 0) + 1);
    }
    // 2. Layers lay up to their cap.
    for (const rec of reg.all()) {
      if (rec.kind !== 'mine_layer') continue;
      const have = perLayer.get(rec.id) ?? 0;
      const working = rec.isConstructed && have < MINES_PER_LAYER && this.d.powered(rec.id);
      this.d.setActive?.(rec, working);
      if (!working) continue;
      const due = this.nextLayAt.get(rec.id) ?? 0;
      if (nowMs < due) continue;
      this.nextLayAt.set(rec.id, nowMs + MINE_LAY_INTERVAL_MS);
      this.lay(rec, nowMs);
    }
    // 3. Forget per-layer timers for layers that are gone.
    if (this.nextLayAt.size > 0) {
      for (const id of this.nextLayAt.keys()) {
        if (reg.get(id) === undefined) {
          this.nextLayAt.delete(id);
          this.laidCount.delete(id);
        }
      }
    }
  }

  /** Lay one mine at the next clear ring spot, if the magazine allows. */
  private lay(rec: StructureRecord, nowMs: number): void {
    let n = this.laidCount.get(rec.id) ?? 0;
    for (let k = 0; k < LAY_TRIES; k++, n++) {
      const a = n * GOLDEN;
      // Alternate between the inner and outer half of the ring.
      const r = n % 2 === 0 ? MINE_RING_MIN + (MINE_RING_MAX - MINE_RING_MIN) * 0.35 : MINE_RING_MIN + (MINE_RING_MAX - MINE_RING_MIN) * 0.85;
      const x = rec.x + Math.cos(a) * r;
      const y = rec.y + Math.sin(a) * r;
      if (!this.d.isClear(x, y)) continue;
      if (!this.spendMine(rec)) return;
      this.laidCount.set(rec.id, n + 1);
      const mine: MineRecord = { id: `mine-${this.counter++}`, layerId: rec.id, owner: rec.owner, x, y, armedAtMs: nowMs + MINE_ARM_MS };
      this.mines.set(mine.id, mine);
      this.d.onLaid(mine);
      return;
    }
    this.laidCount.set(rec.id, n);
  }

  /** The turret magazine rule: one munition reloads several mines. */
  private spendMine(rec: StructureRecord): boolean {
    const per = AMMO_SHOTS_PER_UNIT.mine_layer ?? 1;
    if (!this.d.takeMunition) return true;
    if ((rec.ammo ?? 0) <= 0) {
      if (!this.d.takeMunition(rec)) {
        rec.noAmmo = true;
        return false;
      }
      rec.ammo = per;
    }
    rec.ammo = (rec.ammo ?? 0) - 1;
    rec.noAmmo = false;
    return true;
  }

  private remove(id: string, m: MineRecord): void {
    this.mines.delete(id);
    this.d.onRemoved(m);
  }

  /** Mines of one layer (tests, inspector). */
  countFor(layerId: string): number {
    let n = 0;
    for (const m of this.mines.values()) if (m.layerId === layerId) n++;
    return n;
  }
}
