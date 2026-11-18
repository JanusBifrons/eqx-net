/**
 * The camera director's target lookup over the renderer's sprite map (pixi
 * space), split out of `PixiRenderer.ts`. Built once; its closures and
 * bounds scratch are reused every frame (invariant #14).
 */
import type { Container } from 'pixi.js';
import type { CameraGroup } from '@core/contracts/cameraScript.js';
import type { CameraTargetLookup, MutableBounds, MutablePoint } from './CameraDirector.js';
import { GroupBoundsScanner } from './groupBounds.js';

/** Live view of the renderer state the lookup reads. */
export interface DirectorLookupHost {
  readonly sprites: ReadonlyMap<string, Container>;
  /** The camera, or undefined before `init`. */
  readonly camera: { readonly screenWidth: number; readonly screenHeight: number } | undefined;
  /** The sprite a camera cue follows (`'local'` resolves to the pilot's ship). */
  cameraSprite(id: string): Container | undefined;
}

/** Lookup over the sprite map for the director (pixi space). Built once. */
export function createDirectorLookup(swarmSpriteKinds: ReadonlyMap<string, number>, host: DirectorLookupHost): CameraTargetLookup {
  // Group bounds: `GroupBoundsScanner` (alloc-free, #14), which also counts
  // structures culled off screen (review 2026-11-12, capital-lineup).
  const groupScanner = new GroupBoundsScanner(swarmSpriteKinds);
  // Ids-bounds accumulator state.
  let count = 0;
  let acc: MutableBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  // A framed entity contributes its whole extent (radius `r`), not just its
  // centre: a 10x capital reaches kilometres past its centre (round 3).
  const add = (x: number, y: number, r = 0): void => {
    if (count === 0) {
      acc.minX = x - r; acc.maxX = x + r;
      acc.minY = y - r; acc.maxY = y + r;
    } else {
      if (x - r < acc.minX) acc.minX = x - r;
      if (x + r > acc.maxX) acc.maxX = x + r;
      if (y - r < acc.minY) acc.minY = y - r;
      if (y + r > acc.maxY) acc.maxY = y + r;
    }
    count++;
  };
  // Half the sprite's longer side: covers any rotation. Cinematic-only path.
  const extentOf = (sprite: Container): number => Math.max(sprite.width, sprite.height) / 2;
  return {
    pose: (id: string, out: MutablePoint): boolean => {
      const sp = host.cameraSprite(id);
      if (!sp || !sp.visible) return false;
      out.x = sp.x;
      out.y = sp.y;
      return true;
    },
    groupBounds: (g: CameraGroup, out: MutableBounds): number => groupScanner.scan(host.sprites, g, out),
    idsBounds: (ids: readonly string[], out: MutableBounds): number => {
      count = 0;
      acc = out;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const sp = host.cameraSprite(id);
        if (sp && sp.visible) add(sp.x, sp.y, extentOf(sp));
      }
      return count;
    },
    viewport: (out: MutablePoint): void => {
      out.x = host.camera ? host.camera.screenWidth : 0;
      out.y = host.camera ? host.camera.screenHeight : 0;
    },
  };
}
