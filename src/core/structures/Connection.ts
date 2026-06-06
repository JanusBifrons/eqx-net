/**
 * A grid connection — an undirected link between two structures owned by the
 * same player inside one sector (speed-dial-resource-structures plan, Phase 3).
 * Zone-pure, mirrors eqx-peri's `Connection`. Connections are INTRA-sector only
 * (structure-to-structure, never sector-to-sector).
 *
 * Connections carry power + minerals over the 1 Hz grid pulse. `flowMaterial` +
 * `flashUntilMs` are presentation hints the client reads (via the discrete
 * `grid_pulse` event, never a per-frame stream) to light a segment when it
 * carried flow this pulse.
 */
import { FLASH_DURATION_MS } from './structureGridConstants.js';

export type FlowMaterial = 'power' | 'minerals';

export interface Pose2 {
  x: number;
  y: number;
}

export class Connection {
  /** Material that last flowed across this link (drives the client tint). */
  flowMaterial: FlowMaterial | null = null;
  /** Wall-clock (ms) until which the segment renders "flowing". */
  flashUntilMs = 0;

  constructor(
    readonly id: number,
    readonly aId: string,
    readonly bId: string,
    readonly throughput: number,
  ) {}

  /** The endpoint that is NOT `id`, or null if `id` is not an endpoint. */
  getOtherNode(id: string): string | null {
    if (id === this.aId) return this.bId;
    if (id === this.bId) return this.aId;
    return null;
  }

  /** True if `id` is one of this connection's endpoints. */
  hasNode(id: string): boolean {
    return id === this.aId || id === this.bId;
  }

  /** Light the segment for `durationMs` from `nowMs`, tagged with `material`. */
  flash(nowMs: number, material: FlowMaterial, durationMs: number = FLASH_DURATION_MS): void {
    this.flashUntilMs = nowMs + durationMs;
    this.flowMaterial = material;
  }

  /** True while the flash window is still open. */
  isFlashing(nowMs: number): boolean {
    return nowMs < this.flashUntilMs;
  }
}

/** Euclidean centre-to-centre distance between two poses. */
export function connectionLength(a: Pose2, b: Pose2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
