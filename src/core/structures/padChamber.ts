/**
 * Teleporter chamber walls (teleporter redesign T1), local frame. A chamber
 * pad (`isPadChamberKind`: teleporter, large teleporter, transit pad) is
 * walled all round in the ring band between the pad floor (|x|, |y| ≤
 * padRadius) and the footprint edge, except for one doorway at each local ±y
 * end (|x| < `padDoorwayHalf`). Ships enter and leave along local y.
 *
 * The towers (`padPostCenters`) are listed by `gateGeometry.ts`; this adds the
 * wall boxes BETWEEN them: on each side wall (±x) one box per gap between
 * neighbouring towers, and on each doorway end (±y) a stub from each corner
 * tower's inner face to the doorway edge. An open door leaf slides into its
 * stub (`rigs/transport.ts` `tp-doors`). Boxes never overlap the towers.
 */
import type { LocalBox } from './gateGeometry.js';
import { PAD_SPECS, padDoorwayHalf, padHalfExtent, padPostCenters, type TeleporterKind } from '../../shared-types/teleport.js';

/** The wall boxes of a chamber pad (not its towers), local frame. */
export function padChamberWalls(kind: TeleporterKind): LocalBox[] {
  const post = PAD_SPECS[kind].post;
  const r = PAD_SPECS[kind].padRadius;
  const band = padHalfExtent(kind) - post / 2; // centre line of the wall band
  const door = padDoorwayHalf(kind);
  const out: LocalBox[] = [];
  for (const sx of [-1, 1]) {
    // Side wall: the gaps between the towers standing on it, in y order.
    const ys = padPostCenters(kind).filter(([x]) => x === sx * band).map(([, y]) => y).sort((a, b) => a - b);
    for (let i = 0; i + 1 < ys.length; i++) {
      const y0 = ys[i]! + post / 2, y1 = ys[i + 1]! - post / 2;
      if (y1 > y0) out.push({ cx: sx * band, cy: (y0 + y1) / 2, hw: post / 2, hh: (y1 - y0) / 2 });
    }
  }
  for (const sy of [-1, 1]) {
    // Doorway end: a stub each side of the doorway, tower face to door edge.
    for (const sx of [-1, 1]) out.push({ cx: (sx * (r + door)) / 2, cy: sy * band, hw: (r - door) / 2, hh: post / 2 });
  }
  return out;
}
