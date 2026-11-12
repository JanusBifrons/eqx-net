/**
 * Impact bursts for capital naval shells (turrets T3 follow-up).
 *
 * The server sends no "shell hit" event, so the renderer remembers where each
 * naval shell was last seen and, the frame it disappears, bursts there if it
 * vanished before its full range (it hit something; a shell that ran out of
 * range just fades, see `shellEndedOnHit`).
 *
 * Everything here is GAME space (Y up): positions come straight from
 * `mirror.projectiles` and go straight to `FxExplosions.spawn`, which flips Y
 * itself. The inline renderer code this replaced stored the Pixi-space `-y`,
 * so Y was flipped twice and the burst landed at the shell's vertical mirror
 * about y = 0 (capital-guns-fighter review 2026-11-10: the fireball ~380 px
 * straight above the fighter the shells had just hit).
 *
 * Pooled records, generation-stamped sweep: no per-frame allocation once
 * warm (invariant #14).
 */
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';
import { shellEndedOnHit, shellImpactRadius } from './turretFx.js';

interface ShellRec { x: number; y: number; r: number; sx: number; sy: number; reach: number; gen: number; ev: boolean }

/** The fields of a `mirror.projectiles` entry this reads (game space). */
export interface ShellView { x: number; y: number; weaponId?: string; beam?: unknown; event?: boolean }

/** Where a burst goes: `FxExplosions` (game-space input). */
export interface ShellBurstSink {
  spawn(x: number, y: number, r: number, nowMs: number): boolean;
}

export class NavalShellBursts {
  private readonly shells = new Map<string, ShellRec>();
  private readonly free: ShellRec[] = [];
  private gen = 0;

  /** One frame: note every naval shell in `projectiles` (the render mirror's
   *  map, game space), then burst each shell gone since last frame that ended
   *  before its full range.
   *
   *  Shells as events: a shell drawn from its salvo (`event`) never bursts
   *  because it disappeared (it may only have left this viewer's interest:
   *  the false edge burst). Its burst comes from `ends`, flat
   *  `[x, y, shellRadius]` triples in game space, queued when the display
   *  clock reaches its `shell_end` (`mirror.pendingShellEnds`). A shell this
   *  viewer only got per tick keeps the old guess. */
  frame(
    projectiles: ReadonlyMap<string, ShellView> | undefined, sink: ShellBurstSink | null, nowMs: number,
    ends?: readonly number[],
  ): void {
    if (ends) for (let i = 0; i + 2 < ends.length; i += 3) {
      sink?.spawn(ends[i]!, ends[i + 1]!, shellImpactRadius(ends[i + 2]!), nowMs);
    }
    const gen = ++this.gen;
    if (projectiles) for (const [id, p] of projectiles) {
      if (p.beam || p.weaponId === undefined || !p.weaponId.startsWith('naval_')) continue;
      let rec = this.shells.get(id);
      if (rec === undefined) {
        rec = this.free.pop() ?? { x: 0, y: 0, r: 0, sx: 0, sy: 0, reach: 0, gen: 0, ev: false };
        const w = isWeaponId(p.weaponId) ? getWeapon(p.weaponId) : null;
        rec.r = shellImpactRadius(w && w.mode !== 'hitscan' ? w.radius : 3);
        rec.reach = w && w.mode !== 'hitscan' ? (w.speed * (w.mode === 'projectile' ? w.maxTicks : w.lifetimeTicks)) / 60 : 0;
        rec.sx = p.x; rec.sy = p.y;
        this.shells.set(id, rec);
      }
      rec.x = p.x; rec.y = p.y; rec.gen = gen; rec.ev = p.event === true;
    }
    for (const [id, rec] of this.shells) {
      if (rec.gen === gen) continue;
      if (!rec.ev && shellEndedOnHit(Math.hypot(rec.x - rec.sx, rec.y - rec.sy), rec.reach)) sink?.spawn(rec.x, rec.y, rec.r, nowMs);
      this.shells.delete(id);
      this.free.push(rec);
    }
  }

  /** Shells being tracked (tests). */
  count(): number { return this.shells.size; }

  /** Sector handoff: forget everything. */
  reset(): void {
    for (const rec of this.shells.values()) this.free.push(rec);
    this.shells.clear();
  }
}
