/**
 * Server → client `grid_pulse` (Structures plan, Phase 3): light the named
 * connection segments for a full pulse window. Stored on the mirror so the
 * (worker) renderer reads them; joined to structure positions by entityId.
 * The three mirror maps are created once on first use; no per-message
 * allocation (#14).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { GridPulseEvent } from '@shared-types/messages';
import { TRANSFER_PULSE_MS as GRID_PULSE_WINDOW_MS } from '@core/structures/structureGridConstants';
import { flowMaterialToCode } from '../../render/pixi/connectorVisual.js';

/** What the grid-pulse handler touches on the client. */
export interface GridPulseHandlerCtx {
  readonly mirror: RenderMirror;
  /** The injected clock's `now()` (ms). */
  now(): number;
}

export function registerGridPulseHandlers(room: Room, ctx: GridPulseHandlerCtx): void {
  room.onMessage('grid_pulse', (msg: GridPulseEvent) => {
    if (!msg || !Array.isArray(msg.flashed)) return;
    let flashes = ctx.mirror.gridFlashes;
    if (!flashes) { flashes = new Map(); ctx.mirror.gridFlashes = flashes; }
    // R2.2 — recover the flow DIRECTION the sorted key throws away (the comet
    // travels source→dest). Sibling map keyed identically; value = the source.
    let flowSrc = ctx.mirror.gridFlowSrc;
    if (!flowSrc) { flowSrc = new Map(); ctx.mirror.gridFlowSrc = flowSrc; }
    // WS-D (#12) — per-edge flow MATERIAL (numeric code) for the connector
    // tint. Sibling map keyed identically; value = flowMaterialToCode(material).
    let flowMat = ctx.mirror.gridFlowMaterial;
    if (!flowMat) { flowMat = new Map(); ctx.mirror.gridFlowMaterial = flowMat; }
    // R2.2 — keep the edge lit for a FULL pulse period so consecutive 1 Hz
    // pulses read as continuous flow (not a 300 ms blink + 700 ms gap); it
    // fades ~1 s after the flow actually stops being re-stamped.
    const until = ctx.now() + GRID_PULSE_WINDOW_MS;
    const defaultMatCode = flowMaterialToCode(msg.material ?? 'minerals');
    for (const pair of msg.flashed) {
      const a = pair[0];
      const b = pair[1];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 65536 + hi;
      flashes.set(key, until);
      // `a` is the route SOURCE (StructureGridSubsystem.flashRoute pushes
      // [route[i], route[i+1]] in source→dest order; SectorRoom preserves it).
      flowSrc.set(key, a);
      // Per-edge material (WS-D #12); a legacy 2-tuple falls back to the
      // pulse-level `material`.
      const edgeMat = pair[2];
      flowMat.set(key, edgeMat !== undefined ? flowMaterialToCode(edgeMat) : defaultMatCode);
    }
  });
}
