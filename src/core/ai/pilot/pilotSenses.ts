import type { AiEntity, AiWorldView, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import { isFriendly, isNpcAllegianceId, type AllegianceSide } from '../../../shared-types/allegiances.js';
import type { TacticalContext } from '../tactics/manoeuvre.js';
import { LOD_PILOT_RANGE_MUL } from '../tactics/utility.js';
import { COMBAT_NEIGHBOUR_K, COUNT_RANGE_MUL, HIT_HALF_LIFE_TICKS } from '../hostileDroneTuning.js';

/**
 * The pilot's senses at decision time (owned by `HostileDroneBehaviour`, built
 * once): the sensor scan, the side count, the pilot-near LOD check and the
 * decaying recent-hit count. Plain fields, alloc-free (#14); the neighbour
 * index buffer is the brain's shared one.
 */
export class PilotSenses {
  /** Sensor scan (decision time): allies within sensor range, the enemies'
   *  summed radii, a friendly capital seen. */
  sensorAllies = 0;
  enemySize = 0;
  capitalNear = false;
  /** Recent-hit counter (decays with `HIT_HALF_LIFE_TICKS`), from `markHostile`. */
  private _hitsVal = 0;
  private _hitsTick = 0;

  constructor(
    private readonly _nbIdx: Int32Array,
    private readonly allegiance: AllegianceSide,
    private readonly friendlyToPilots: boolean,
    private readonly sensorRange: number,
    private readonly fireRange: number,
  ) {}

  /** A hit landed at `atTick` (the "under fire" signal). */
  noteHit(atTick: number): void {
    this._hitsVal = this.recentHitsAt(atTick) + 1;
    this._hitsTick = atTick;
  }

  /** The decaying recent-hit count at `tick`. */
  recentHitsAt(tick: number): number {
    if (this._hitsVal <= 0) return 0;
    const age = tick - this._hitsTick;
    return age <= 0 ? this._hitsVal : this._hitsVal * Math.pow(0.5, age / HIT_HALF_LIFE_TICKS);
  }

  /**
   * Sensor picture at decision time (one K ≤ 8 grid query within sensor
   * range): same-side ships (their centroid, the nearest friendly capital:
   * the fall-back anchor) and enemies (count, summed radii, radius-weighted
   * centroid: what Flee runs from). Plain writes into the context (#14).
   */
  scanSensors(self: AiEntity, nb: IAiNeighbourQuery, c: TacticalContext): void {
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, this.sensorRange, COMBAT_NEIGHBOUR_K, idx, self.id);
    let allies = 0, ax = 0, ay = 0;
    let enemies = 0, ew = 0, ex = 0, ey = 0;
    let capD2 = Infinity, capX = 0, capY = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      const x = nb.xAt(i), y = nb.yAt(i);
      const pilot = nb.isPilotAt(i);
      const side = nb.sideAt(i);
      if (pilot ? this.friendlyToPilots : side === this.allegiance) {
        allies++;
        ax += x; ay += y;
        // A friendly capital anchors morale whoever flies it (a pilot's too).
        if (nb.isCapitalAt(i)) {
          const d2 = (x - self.x) * (x - self.x) + (y - self.y) * (y - self.y);
          if (d2 < capD2) { capD2 = d2; capX = x; capY = y; }
        }
      } else if (pilot ? !this.friendlyToPilots : !isNpcAllegianceId(side) || !isFriendly(this.allegiance, side)) {
        const r = nb.radiusAt(i) > 1 ? nb.radiusAt(i) : 1;
        enemies++;
        ew += r; ex += x * r; ey += y * r;
      }
    }
    this.sensorAllies = allies;
    this.enemySize = ew;
    this.capitalNear = capD2 < Infinity;
    c.sensorEnemies = enemies;
    if (enemies > 0) { c.threatX = ex / ew; c.threatY = ey / ew; }
    if (this.capitalNear) { c.hasAnchor = true; c.anchorX = capX; c.anchorY = capY; }
    else if (allies > 0) { c.hasAnchor = true; c.anchorX = ax / allies; c.anchorY = ay / allies; }
    else c.hasAnchor = false;
  }

  /** Any pilot hull within `LOD_PILOT_RANGE_MUL` × sensor range? */
  pilotNear(self: AiEntity, view: AiWorldView): boolean {
    const r = LOD_PILOT_RANGE_MUL * this.sensorRange;
    const r2 = r * r;
    const ps = view.players;
    for (let i = 0; i < ps.length; i++) {
      const dx = ps[i]!.x - self.x;
      const dy = ps[i]!.y - self.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /** Same-side and other ships within `COUNT_RANGE_MUL` × fire range (K ≤ 8). */
  countSides(self: AiEntity, nb: IAiNeighbourQuery, c: TacticalContext): void {
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, this.fireRange * COUNT_RANGE_MUL, COMBAT_NEIGHBOUR_K, idx, self.id);
    let allies = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      if (nb.isPilotAt(i) ? this.friendlyToPilots : nb.sideAt(i) === this.allegiance) allies++;
    }
    c.allies = allies;
    c.enemies = n - allies;
  }
}
