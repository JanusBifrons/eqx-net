/**
 * Per-viewer interest window (centre cell + reach in cells), recorded each
 * tick by the swarm broadcast beside its 9-cell scratch set and read by the
 * snapshot broadcast. Pilot hulls are not grid entities, so the wide-owner
 * shot rule tests a hull's cell against this window, exactly as
 * `SpatialGrid.query9` admits a wide swarm entity (player capitals slice 1;
 * docs/architecture/shell-events.md §3). Alloc-free on the hot path (#14).
 */
import { CELL_SIZE, coordToCell } from './SpatialGrid.js';

interface Window { cx: number; cy: number; reach: number }

export class ViewerInterestWindows {
  private readonly windows = new Map<string, Window>();

  /** Record a viewer's window this tick (the entry is reused). */
  note(sessionId: string, cx: number, cy: number, reach: number): void {
    const w = this.windows.get(sessionId);
    if (w === undefined) { this.windows.set(sessionId, { cx, cy, reach }); return; }
    w.cx = cx; w.cy = cy; w.reach = reach;
  }

  forget(sessionId: string): void { this.windows.delete(sessionId); }

  /** The viewer's reach in cells; 1 (the 3×3 window) before the first note. */
  reachOf(sessionId: string): number { return this.windows.get(sessionId)?.reach ?? 1; }

  /** Is a WIDE hull (radius over half a cell) at (x, y) inside the viewer's
   *  window, widened by the hull's own cells? A small hull is never wide. */
  wideHullIn(sessionId: string, x: number, y: number, radius: number): boolean {
    const w = this.windows.get(sessionId);
    if (w === undefined || radius <= CELL_SIZE / 2) return false;
    const reach = w.reach + Math.ceil(radius / CELL_SIZE);
    return Math.abs(coordToCell(x) - w.cx) <= reach && Math.abs(coordToCell(y) - w.cy) <= reach;
  }
}
