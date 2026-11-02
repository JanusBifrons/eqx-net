/**
 * v4 A — what the inspector says about an alien gate: where it leads and when
 * it next jumps. Both come from shared pure code (the gate sites and the
 * timetable), so the client needs nothing extra on the wire. The countdown
 * uses this browser's clock, so it is approximate ("about").
 */
import { alienGateSites } from '../../core/galaxy/alienGates';
import { getSector } from '../../core/galaxy/galaxy';
import { alienGateOffsetMs, nextAlienGateJumpMs } from '../../shared-types/teleport';

/** The sector an alien gate at (x, y) in `sectorKey` leads to: the nearest
 *  ideal site (a gate may sit a little off it when a base was there first). */
export function alienGateNeighbour(sectorKey: string, x: number, y: number): string | null {
  let best: string | null = null;
  let bestD = 3000;
  for (const s of alienGateSites(sectorKey)) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = s.neighbour;
    }
  }
  return best;
}

/** "Leads to Vega Reach · next jump in about 12 s" (null if unknown). */
export function alienGateLine(sectorKey: string | null, x: number, y: number, nowMs: number): string | null {
  if (sectorKey === null) return null;
  const n = alienGateNeighbour(sectorKey, x, y);
  if (n === null) return null;
  const name = getSector(n)?.name ?? 'the next sector';
  const secs = Math.max(0, Math.ceil((nextAlienGateJumpMs(nowMs, alienGateOffsetMs(sectorKey, n)) - nowMs) / 1000));
  return `Leads to ${name} · next jump in about ${secs} s`;
}
