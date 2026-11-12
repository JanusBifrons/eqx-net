/**
 * Which sprites a `frame { group }` camera shot fits, and their bounds.
 *
 * A hidden sprite is normally gone from the world (a ship on its warp run), so
 * it is left out. Structures are the exception: the renderer hides structure
 * sprites that are OFF SCREEN (view culling in `swarmSpriteUpdater`), and a
 * shot must still frame what is off screen. Counting only visible sprites made
 * the framing depend on the current view: `frame all` in the capital-lineup
 * take left out the base until the camera had already panned onto it
 * (review 2026-11-12).
 *
 * Per-frame (cinematic path): `scan` allocates nothing (invariant #14) — one
 * pre-bound `Map.forEach` visitor and caller-owned bounds.
 */
import type { CameraGroup } from '@core/contracts/cameraScript.js';
import type { MutableBounds } from './CameraDirector.js';

/** The sprite fields the scan reads (a Pixi `Container` has them all). */
export interface FramedSprite {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

/** Swarm kind of a structure (pose-core `kind` 2). */
const STRUCTURE_KIND = 2;

function groupKind(group: CameraGroup): number {
  return group === 'asteroids' ? 0 : group === 'drones' ? 1 : group === 'structures' ? 2 : 3;
}

/** True when the sprite keyed `key` (swarm kind `swarmKind`, undefined for a
 *  player ship) belongs in `group` this frame. Pure. */
export function inFrameGroup(group: CameraGroup, key: string, swarmKind: number | undefined, visible: boolean): boolean {
  if (!visible && swarmKind !== STRUCTURE_KIND) return false;
  if (group === 'all') return true;
  const isSwarm = key.startsWith('swarm-');
  if (group === 'ships') return !isSwarm;
  return isSwarm && swarmKind === groupKind(group);
}

/** Accumulates the bounds of a group over a sprite map. One per renderer. */
export class GroupBoundsScanner {
  private group: CameraGroup = 'all';
  private count = 0;
  private out: MutableBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /** `swarmKinds`: sprite key → swarm kind (absent for player ships). */
  constructor(private readonly swarmKinds: ReadonlyMap<string, number>) {}

  /** Bounds of `group` into `out` (pixi space; each sprite contributes half
   *  its longer side all round, covering any rotation). Returns the member
   *  count; 0 ⇒ `out` untouched. */
  scan(sprites: ReadonlyMap<string, FramedSprite>, group: CameraGroup, out: MutableBounds): number {
    this.group = group;
    this.count = 0;
    this.out = out;
    sprites.forEach(this.visit);
    return this.count;
  }

  private readonly visit = (sprite: FramedSprite, key: string): void => {
    if (!inFrameGroup(this.group, key, this.swarmKinds.get(key), sprite.visible)) return;
    const r = Math.max(sprite.width, sprite.height) / 2;
    const o = this.out;
    const x = sprite.x;
    const y = sprite.y;
    if (this.count === 0) {
      o.minX = x - r; o.maxX = x + r;
      o.minY = y - r; o.maxY = y + r;
    } else {
      if (x - r < o.minX) o.minX = x - r;
      if (x + r > o.maxX) o.maxX = x + r;
      if (y - r < o.minY) o.minY = y - r;
      if (y + r > o.maxY) o.maxY = y + r;
    }
    this.count++;
  };
}
