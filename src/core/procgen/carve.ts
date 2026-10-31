/**
 * Generate-then-REPAIR: open sealed pockets (plan: soft-leaping-truffle).
 *
 * Bigger architecture (bays lined with container rows, wall corners, trimmed
 * rack ends) can combine into pockets a ship could see but never enter. Rather
 * than re-roll the whole seed, carve: remove the CARVABLE pieces (racks,
 * containers — never walls or gate posts) whose footprint, grown by the
 * flyable clearance, touches BOTH a sealed pocket and reachable space. Those
 * are exactly the pieces standing in the doorway. Repeat until no pocket is
 * left (or the pass cap is hit — then the caller's validator rejects).
 *
 * Deterministic (integer grid, ordered scans) and generation-time only.
 */
import { basePieceIndex } from '../../shared-types/basePieceKinds.js';
import type { BaseDescriptor, BaseLayout } from './baseLayout.js';
import { LayoutBuilder } from './baseLayout.js';
import { floodReachable, OCCUPANCY_CELL } from './validate.js';

const CARVABLE = new Set([basePieceIndex('rack_row'), basePieceIndex('container_stack')]);
export const MAX_CARVE_PASSES = 6;

export function carveSealedPockets(l: BaseLayout, desc: BaseDescriptor): BaseLayout {
  let cur = l;
  for (let pass = 0; pass < MAX_CARVE_PASSES; pass++) {
    const f = floodReachable(cur);
    if (f.sealed === 0) return cur;
    const g = f.grid;
    const need = f.need;
    const isSealed = (i: number): boolean => f.reached[i] === 0 && g.clearance[i]! >= need;
    const grow = Math.ceil(need / 3) + 1; // cells
    const remove = new Uint8Array(cur.count);
    let removed = 0;
    for (let i = 0; i < cur.count; i++) {
      if (!CARVABLE.has(cur.kind[i]!)) continue;
      const cx0 = Math.floor((cur.x[i]! - g.origin) / OCCUPANCY_CELL) - grow;
      const cy0 = Math.floor((cur.y[i]! - g.origin) / OCCUPANCY_CELL) - grow;
      const cx1 = Math.floor((cur.x[i]! + cur.w[i]! - 1 - g.origin) / OCCUPANCY_CELL) + grow;
      const cy1 = Math.floor((cur.y[i]! + cur.h[i]! - 1 - g.origin) / OCCUPANCY_CELL) + grow;
      let touchesSealed = false;
      let touchesReached = false;
      for (let cy = Math.max(0, cy0); cy <= Math.min(g.n - 1, cy1) && !(touchesSealed && touchesReached); cy++) {
        for (let cx = Math.max(0, cx0); cx <= Math.min(g.n - 1, cx1); cx++) {
          const c = cy * g.n + cx;
          if (f.reached[c]) touchesReached = true;
          else if (isSealed(c)) touchesSealed = true;
          if (touchesSealed && touchesReached) break;
        }
      }
      if (touchesSealed && touchesReached) {
        remove[i] = 1;
        removed++;
      }
    }
    if (removed === 0) return cur; // nothing carvable borders the pocket
    const b = new LayoutBuilder(cur.half);
    for (let i = 0; i < cur.count; i++) {
      if (remove[i]) continue;
      b.addRect(cur.kind[i]!, cur.x[i]!, cur.y[i]!, cur.x[i]! + cur.w[i]!, cur.y[i]! + cur.h[i]!);
    }
    for (let k = 0; k < cur.gates.length; k += 2) b.addGate(cur.gates[k]!, cur.gates[k + 1]!);
    cur = b.build(desc, cur.attempts);
  }
  return cur;
}
