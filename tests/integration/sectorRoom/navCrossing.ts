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

/** Two open spots either side of a big rock in a sparse chunk (the straight
 *  line between them blocked, a fighter route round it). */
export function crossing(): { ax: number; ay: number; bx: number; by: number } {
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
      if (p.roomAt(ax, r.y) >= room && p.roomAt(bx, r.y) >= room && !p.segmentClear(ax, r.y, bx, r.y, c) &&
        p.plan(coarse, fine, ax, r.y, bx, r.y, c, out) > 1 && p.status === 'route') return { ax, ay: r.y, bx, by: r.y };
    }
  }
  throw new Error('no crossing');
}

