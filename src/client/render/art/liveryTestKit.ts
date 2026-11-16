/**
 * Shared helpers for the livery locks (`fields.livery*.test.ts`), split over
 * several files so vitest runs them on parallel workers. Used only by tests.
 *
 * Sampling: a few locks run on CAPITAL_SAMPLE instead of every capital, where
 * the capital repeat runs the same code path at a test-only ppu (3x-6x the
 * fast ppu, a capital forge there is 0.5-2 s). Every lock on the shipping
 * default ('b8': two deck sigils) still runs on every capital.
 */
import { forgeShip, shipExtent, type Fields } from './fields.js';
import { SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';

/** forgeShip is deterministic and the tests here only read its output, so
 *  repeat forges (the plain hull, a livery several tests inspect) come from a
 *  small cache: the file forged hundreds of identical hulls and ran past CI's
 *  unit-test time limit. Least-recently-used, bounded by texels, not entries
 *  (a 6x capital is ~0.25 M texels at 37 B each; the cap is ~110 MB): an entry
 *  cap let a run of small sub-cap forges evict the capital forge the next test
 *  re-reads. */
const FORGE_CACHE = new Map<string, Fields>();
const FORGE_CACHE_TEXELS = 3_000_000;
let cachedTexels = 0;
export function forged(id: string, opts: Parameters<typeof forgeShip>[1]): Fields {
  const k = id + JSON.stringify(opts);
  const hit = FORGE_CACHE.get(k);
  if (hit) { FORGE_CACHE.delete(k); FORGE_CACHE.set(k, hit); return hit; }
  const f = forgeShip(id, opts);
  FORGE_CACHE.set(k, f);
  cachedTexels += f.cov.length;
  while (cachedTexels > FORGE_CACHE_TEXELS && FORGE_CACHE.size > 1) {
    const [oldK, old] = FORGE_CACHE.entries().next().value!;
    FORGE_CACHE.delete(oldK);
    cachedTexels -= old.cov.length;
  }
  return f;
}

/** ~240 texels across whatever the size: fast, still every feature. */
export const ppuFor = (id: string): number => Math.min(2, 120 / shipExtent(id));

export function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export const hex3 = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
export const linToSrgb8 = (v: number): number => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));

export const SUBCAPS = SHIP_KINDS_LIST.filter((k) => k.sizeClass !== 'capital').map((k) => k.id);
// The warships: the mining barge's livery (container deck, no clear sigil
// field) is not tuned yet, so the warship livery locks leave it out.
export const CAPITALS = SHIP_KINDS_LIST.filter((k) => k.sizeClass === 'capital' && k.id !== 'barge').map((k) => k.id);
/** One capital per extreme and per hull family: the smallest (destroyer), the
 *  largest with the most turrets (battleship), a '-b' and a '-c' hull. */
export const CAPITAL_SAMPLE = ['destroyer', 'battleship', 'light-cruiser-b', 'heavy-cruiser-c'];

export function pointIn(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
