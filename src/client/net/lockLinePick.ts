/**
 * Lock-line pick scratch (`ColyseusClient.updateLockGuide`): the lockable
 * target nearest the guideline within reach — the shared `lockLineScore`
 * rule, the one the server uses to verify `lock_track` (#15). Contacts
 * (drones, structures, other pilots) and neutral terrain (asteroid, scrap /
 * loot pod, wreck piece; shared `isTerrainLockKind`) are scored in separate
 * tiers: terrain is the LOWEST priority and wins only with no contact on the
 * line. One pick at a time; reused, alloc-free per candidate (#14).
 */
import { lockLineScore } from '@core/combat/lockLine';

export class LockLinePick {
  private x = 0;
  private y = 0;
  private dirX = 0;
  private dirY = 1;
  private reach = 0;
  /** Sticky: the target the line already holds keeps it inside a wider cone. */
  private held: string | null = null;
  private best: string | null = null;
  private bestScore = Infinity;
  private terrainBest: string | null = null;
  private terrainScore = Infinity;

  /** Start a pick from (x, y) along `bearing` (ship-angle convention). */
  begin(x: number, y: number, bearing: number, reach: number, held: string | null): void {
    this.x = x;
    this.y = y;
    this.dirX = -Math.sin(bearing);
    this.dirY = Math.cos(bearing);
    this.reach = reach;
    this.held = held;
    this.best = null;
    this.bestScore = Infinity;
    this.terrainBest = null;
    this.terrainScore = Infinity;
  }

  /** Score one candidate into its tier (contact, or terrain when `terrain`). */
  consider(key: string, x: number, y: number, radius: number, terrain: boolean): void {
    const score = lockLineScore(x - this.x, y - this.y, this.dirX, this.dirY, radius, this.reach, key === this.held);
    if (terrain) {
      if (score < this.terrainScore) {
        this.terrainScore = score;
        this.terrainBest = key;
      }
    } else if (score < this.bestScore) {
      this.bestScore = score;
      this.best = key;
    }
  }

  /** The best contact, else the best terrain, else null. */
  result(): string | null {
    return this.best ?? this.terrainBest;
  }
}
