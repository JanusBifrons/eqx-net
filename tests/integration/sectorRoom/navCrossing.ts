/** Shared fixture for the nav integration tests (navigation slices 7, 12). */
import { rocksInChunk, type ChunkOpts } from '../../../src/core/terrain/fieldLayout.js';
import { fieldRockBody } from '../../../src/core/terrain/chunkStreamer.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { RoutePlanner } from '../../../src/core/nav/routePlanner.js';
import { CoarseFieldMap } from '../../../src/core/nav/coarseField.js';
import { FineFieldLayer } from '../../../src/core/nav/fineField.js';

const fighter = getShipKind('fighter');
const opts: ChunkOpts = { seed: 'look', battleshipLength: getShipKind('battleship').radius * 2, fighterLength: fighter.radius * 2 };

/** A crossing: two open spots either side of a big rock, and the fighter route's length. */
export interface Crossing { ax: number; ay: number; bx: number; by: number; routeLen: number }

/** Two open spots either side of a big rock in a sparse chunk (the straight
 *  line between them blocked, a fighter route round it), the biggest rock
 *  first, whose fighter route is at most `maxRouteLen` long. Unbounded, it is
 *  the field's own street crossing (fine rebuild slice A: the big rock's way
 *  round threads the packed rocks beside it, 8 waypoints, ~3 900 u). */
export function crossing(maxRouteLen = Infinity): Crossing {
  const coarse = new CoarseFieldMap(); coarse.build(opts);
  const fine = new FineFieldLayer(opts);
  const p = new RoutePlanner(), c = shipTuning(fighter).navClearance, room = 6 * fighter.radius;
  const cx = 20, cy = 10, out = new Float64Array(128);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) fine.chunkLoaded(cx + dx, cy + dy);
  p.plan(coarse, fine, 0, 0, 0, 0, 0, out); // seed the planner's layers
  for (const r of rocksInChunk(opts, cx, cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius)) {
    if (r.radius < 6 * fighter.radius) continue;
    for (let d = r.radius + 300; d < r.radius + 1500; d += 100) {
      const ax = r.x - d, bx = r.x + d;
      if (p.roomAt(ax, r.y) < room || p.roomAt(bx, r.y) < room || p.segmentClear(ax, r.y, bx, r.y, c)) continue;
      const n = p.plan(coarse, fine, ax, r.y, bx, r.y, c, out);
      if (n <= 1 || p.status !== 'route') continue;
      let routeLen = Math.hypot(out[0]! - ax, out[1]! - r.y);
      for (let k = 1; k < n; k++) routeLen += Math.hypot(out[2 * k]! - out[2 * k - 2]!, out[2 * k + 1]! - out[2 * k - 1]!);
      if (routeLen <= maxRouteLen) return { ax, ay: r.y, bx, by: r.y, routeLen };
    }
  }
  throw new Error('no crossing');
}
