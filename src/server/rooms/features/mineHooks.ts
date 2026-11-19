/**
 * Mine Layers — where a mine may be laid and what its blast does. Moved
 * verbatim out of `SectorRoom`; `MineFieldSubsystem` calls these through
 * the room's deps, and the room hands in live accessors.
 */
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { MineFieldSubsystem, MineRecord, MineTarget } from '../../structures/MineFieldSubsystem.js';
import { MINE_BLAST_RADIUS, MINE_CLEARANCE, MINE_DAMAGE, type MineDetonated } from '../../../shared-types/mines.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../shared-types/sectorBounds.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';

/** What the mine hooks need from the room; getters read the live field. */
export interface MineHookHost {
  structureRegistry: Pick<StructureRegistry, 'all'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  sabF32(): Float32Array;
  mineField(): Pick<MineFieldSubsystem, 'mines'>;
  applyDamage(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): boolean;
  broadcast(type: string, msg: unknown): void;
}

export class MineHooks {
  constructor(private readonly h: MineHookHost) {}

  /** A mine spot keeps clear of structure boxes, asteroids, other mines and
   *  the sector edge. Called only when a layer lays (rare). */
  mineSpotClear(x: number, y: number): boolean {
    const c = MINE_CLEARANCE;
    if (Math.abs(x) > SECTOR_PLAYABLE_HALF_EXTENT - c || Math.abs(y) > SECTOR_PLAYABLE_HALF_EXTENT - c) return false;
    for (const r of this.h.structureRegistry.all()) {
      const dx = Math.max(Math.abs(x - r.x) - (r.halfW ?? r.radius), 0);
      const dy = Math.max(Math.abs(y - r.y) - (r.halfH ?? r.radius), 0);
      if (dx * dx + dy * dy < c * c) return false;
    }
    for (const rec of this.h.swarmRegistry.all()) {
      if (rec.kind !== 0) continue;
      const b = slotBase(rec.slot);
      const d = rec.radius + c;
      if ((this.h.sabF32()[b + SLOT_X_OFF]! - x) ** 2 + (this.h.sabF32()[b + SLOT_Y_OFF]! - y) ** 2 < d * d) return false;
    }
    for (const m of this.h.mineField().mines.values()) {
      if ((m.x - x) ** 2 + (m.y - y) ** 2 < 4 * c * c) return false;
    }
    return true;
  }

  /** A mine went off: hurt the ship that set it off (the layer is the
   *  attacker, like a turret) and show the blast to everyone. */
  detonateMine(mine: MineRecord, target: MineTarget): void {
    this.h.applyDamage(target.id, mine.layerId, MINE_DAMAGE, mine.x, mine.y);
    const msg: MineDetonated = { type: 'mine_detonated', x: mine.x, y: mine.y, radius: MINE_BLAST_RADIUS };
    this.h.broadcast('mine_detonated', msg);
  }
}
