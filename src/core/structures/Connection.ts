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

/**
 * The kind of flow that last crossed a connection this pulse — a PRESENTATION
 * hint the client maps to a connector tint (WS-D #12):
 *   - `minerals`     → orange (hauling ore to a Capital / reclaiming)
 *   - `repair`       → green  (healing a damaged structure)
 *   - `construction` → cyan   (building a blueprint)
 *   - `power`        → reserved (power is aggregated, not flashed, in Phase 3)
 * Append-only — it's a JSON presentation string, not a wire-versioned binary
 * field. The ABSENCE of a flash (idle) renders muted-blue; there is no `'idle'`
 * material because an idle edge simply isn't in the pulse's flash set.
 */
export type FlowMaterial = 'power' | 'minerals' | 'repair' | 'construction';

/** No socket: a fence link (emitter post to post) runs straight, centre to
 *  centre, as before the sockets. Lives here (the leaf module) so `Connection`
 *  can default to it without an import cycle; `cableCurve.ts` re-exports it. */
export const CABLE_NO_SOCKET = -1;

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
    /** 0d cable sockets: index into `structureSockets(kind)` of the `aId`
     *  end the cable leaves from (the pair `canConnect` picked), or
     *  `CABLE_NO_SOCKET` for a fence link. Fixed for the link's life, so
     *  a cable never jumps when other links come and go. */
    readonly socketA: number = CABLE_NO_SOCKET,
    /** The `bId` end's socket index (as `socketA`). */
    readonly socketB: number = CABLE_NO_SOCKET,
  ) {}

  /** The socket index at endpoint `id`, or `CABLE_NO_SOCKET` if `id` is
   *  not an endpoint (or the link is a fence link). */
  socketAt(id: string): number {
    if (id === this.aId) return this.socketA;
    if (id === this.bId) return this.socketB;
    return CABLE_NO_SOCKET;
  }

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
