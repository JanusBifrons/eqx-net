/**
 * GalaxyStatsView — the director's read-only galaxy-map views: the cached live
 * per-sector snapshot behind `GET /galaxy/snapshot`, the per-sector active-bot
 * counts fed to the other director, and the per-player structure presence.
 * Moved verbatim out of `LivingWorldDirector.ts`; `recompute()` runs once per
 * ~1.5 s control tick (never the 60 Hz loop), so HTTP reads are O(1).
 */
import { sectorController } from '../../../core/galaxy/control.js';
import { enemyBotCountsBySector } from '../population.js';
import type { SectorLiveState, SectorOwner } from '../../../shared-types/galaxySnapshot.js';
import type { WorldEventView } from '../../../shared-types/worldEvents.js';
import type { SectorStructurePresence } from '../../../shared-types/galaxyPresence.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { HunterBotPool } from './HunterBotPool.js';
import type { SquadPool } from './SquadPool.js';

export interface GalaxyStatsViewDeps {
  rooms: Map<string, LivingWorldRoom>;
  pool: HunterBotPool;
  squadPool: SquadPool;
  /** The director's hooks object (mutated in place by `setHooks`, so read live). */
  hooks: {
    extraEnemyCounts?: () => ReadonlyMap<string, number>;
    sectorOwner?: (sectorKey: string) => SectorOwner | null | undefined;
    sectorElite?: (sectorKey: string) => string | null;
    sectorCapital?: (sectorKey: string) => { name: string; kind: string } | null;
    sectorEvent?: (sectorKey: string) => WorldEventView | null;
  };
}

export class GalaxyStatsView {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly pool: HunterBotPool;
  private readonly squadPool: SquadPool;
  private readonly hooks: GalaxyStatsViewDeps['hooks'];
  /** Phase-3 — cached live per-sector snapshot for `GET /galaxy/snapshot`,
   *  recomputed once per ~1.5 s control tick so HTTP requests are O(1). */
  private galaxyStatsCache: SectorLiveState[] = [];

  constructor(deps: GalaxyStatsViewDeps) {
    this.rooms = deps.rooms;
    this.pool = deps.pool;
    this.squadPool = deps.squadPool;
    this.hooks = deps.hooks;
  }

  /** Recompute the cached `/galaxy/snapshot` live state — one entry per galaxy
   *  room. The room reports its TOTAL present drones (enemies+neutrals) +
   *  players + structures; the director RE-SPLITS enemies vs neutrals by
   *  FACTION-hostility, not the room's present-player view.
   *
   *  Why: hostility is faction → faction (each player is their own faction). A
   *  drone is an "enemy" the moment its squad is DISPATCHED at a base
   *  (targetFactionId set) — independent of whether the targeted player is
   *  present (Equinox: waves attack regardless of presence). The room's
   *  `liveCounts` only knew "hostile to a PRESENT player", so an offline base
   *  under attack showed zero enemies on the map. The squad-derived count fixes
   *  that: a dispatched wave shows red in whatever sector its members occupy,
   *  from dispatch through traversal to arrival; roaming squads stay neutral.
   *  Runs on the ~1.5 s control tick (never the 60 Hz loop), so allocating here
   *  is fine. */
  recompute(): void {
    const enemyBySector = enemyBotCountsBySector(this.squadPool.all(), (id) => this.pool.get(id));
    // P1b — robots (another director) are enemies of every player on sight.
    const extraEnemies = this.hooks.extraEnemyCounts?.();
    const out: SectorLiveState[] = [];
    for (const [key, room] of this.rooms) {
      const counts = room.liveCounts?.() ?? {
        players: room.playerCount(),
        enemies: 0,
        neutrals: 0,
        structures: 0,
      };
      // Total drones actually present in the sector (the room is ground truth
      // for "how many"); the director decides the enemy/neutral SPLIT by wave.
      const totalDrones = counts.enemies + counts.neutrals;
      const enemies = Math.min(
        (enemyBySector.get(key) ?? 0) + (extraEnemies?.get(key) ?? 0),
        totalDrones,
      );
      const neutrals = Math.max(0, totalDrones - enemies);
      const controller = sectorController(key);
      const liveOwner = this.hooks.sectorOwner?.(key);
      out.push({
        key,
        players: counts.players,
        enemies,
        neutrals,
        structures: counts.structures,
        // The control meter's holder (null = neutral); with no meter, the static controller.
        owner: liveOwner !== undefined ? liveOwner : (controller ? { factionId: controller, contested: false } : null),
        // Equinox Phase 9 (item 5) — recent-combat tally (null when quiet); the
        // room owns the sliding window, the director just forwards it.
        recentCombat: room.recentCombat?.() ?? null,
        // P4a — a named elite in this sector (the map's elite marker).
        elite: this.hooks.sectorElite?.(key) ?? null,
        // W2a — a capital fleet here (the map's capital marker).
        capital: this.hooks.sectorCapital?.(key) ?? null,
        // P4b — a world event in this sector.
        event: this.hooks.sectorEvent?.(key) ?? null,
      });
    }
    this.galaxyStatsCache = out;
  }

  /** P1b — this director's ACTIVE bots per sector (control-cadence callers only;
   *  allocates). The robot director feeds this to the drone director's
   *  `extraEnemyCounts` hook so robots show red on the galaxy map. */
  activeBotCountsBySector(): Map<string, number> {
    const out = new Map<string, number>();
    for (const rec of this.pool.values()) {
      if (rec.state !== 'active') continue;
      out.set(rec.sectorKey, (out.get(rec.sectorKey) ?? 0) + 1);
    }
    return out;
  }

  /** Phase-3 — the cached live per-sector snapshot. O(1): served from the
   *  control-tick cache. */
  galaxySnapshot(): SectorLiveState[] {
    return this.galaxyStatsCache;
  }

  /** Equinox Phase 7 — per-sector count of structures owned by `playerId` (the
   *  galaxy-map "my structures" overlay). Computed ON DEMAND from each live
   *  room's registry (per-player, so it can't share the global snapshot cache);
   *  off the 60 Hz tick — called at the ~4 s presence poll. Sectors where the
   *  player owns nothing are omitted, keeping the payload small. */
  playerStructurePresence(playerId: string): SectorStructurePresence[] {
    const out: SectorStructurePresence[] = [];
    for (const [key, room] of this.rooms) {
      const n = room.ownedStructureCount?.(playerId) ?? 0;
      if (n > 0) out.push({ key, structures: n });
    }
    return out;
  }
}
