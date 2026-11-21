/**
 * perf/connector-zoom-rebuild — owner report (phone, ~180-structure base):
 * zooming in and out still stalls, clustered at viewHalf 512–2048. Every
 * half-octave zoom key crossed redrew (and Pixi re-tessellated) the WHOLE
 * static connector layer, and the per-frame layer drew every structure's
 * bars and walls whether on screen or not. Gated on counts, never time.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { buildStructureLattice } from '../../../core/structures/structureLattice.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

const N = 180;

function base(): RenderMirror {
  const lat = buildStructureLattice({ n: N, seed: 7, fence: true });
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  lat.placements.forEach((p, i) => {
    swarm.set(i + 1, {
      x: p.x, y: p.y, vx: 0, vy: 0, angle: ((p.rot ?? 0) * Math.PI) / 180, angvel: 0,
      prevX: p.x, prevY: p.y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: getStructureKind(p.kind).radius, kind: 2, shipKind: p.kind, sleeping: true, lastUpdateTick: 0,
    } as SwarmRenderState);
    // Every 5th one a blueprint: it draws a build bar on the per-frame layer.
    const built = i % 5 !== 0;
    structures.set(i + 1, { powered: true, netPower: 50, connTo: [], built, buildPct: 0.4, deconstructPct: 0, wallActive: true } as StructureRenderState);
  });
  for (const [a, b] of lat.edges) {
    structures.get(a + 1)!.connTo.push(b + 1);
    structures.get(b + 1)!.connTo.push(a + 1);
  }
  return { swarm, structures } as unknown as RenderMirror;
}

/** A sideways phone (915 x 412 CSS px) looking at (cx, cy) in pixi space
 *  with `viewHalf` world units from the centre to the side edge. */
function phoneView(out: Float64Array, cx: number, cy: number, viewHalf: number): number {
  const hh = (viewHalf * 412) / 915;
  out[0] = cx - viewHalf; out[1] = cy - hh; out[2] = cx + viewHalf; out[3] = cy + hh;
  return 915 / 2 / viewHalf; // the camera scale
}

/** One pinch from viewHalf `from` to `to` over `frames` frames. */
function pinch(r: ConnectorRenderer, m: RenderMirror, view: Float64Array, from: number, to: number, frames: number, t0: number): number {
  for (let i = 0; i <= frames; i++) {
    const scale = phoneView(view, 0, 0, from * Math.pow(to / from, i / frames));
    r.update(m, scale, t0 + i * 16);
  }
  return t0 + (frames + 1) * 16;
}

describe('ConnectorRenderer zoom sweep (perf/connector-zoom-rebuild)', () => {
  it('pinching 512 -> 2048 and back again redraws nothing once each zoom key has been drawn', () => {
    const m = base();
    const r = new ConnectorRenderer();
    const view = new Float64Array(4);
    r.viewBounds = view;
    let t = pinch(r, m, view, 512, 2048, 40, 0);
    t = pinch(r, m, view, 2048, 512, 40, t);
    const firstRoundTrip = { rebuilds: r.staticRebuilds, drawn: r.staticStructuresDrawn };
    console.log(`first round trip over ${m.structures!.size} structures: ${firstRoundTrip.rebuilds} static rebuild frames, ${firstRoundTrip.drawn} structures redrawn`);
    // The first trip draws each key once, on-screen chunks only. Before: 9
    // full-base redraws (2124 structures) on this trip, about 8 more per later trip.
    expect(firstRoundTrip.drawn).toBeLessThan(m.structures!.size);
    for (let k = 0; k < 3; k++) {
      t = pinch(r, m, view, 512, 2048, 40, t);
      t = pinch(r, m, view, 2048, 512, 40, t);
    }
    expect(r.staticRebuilds).toBe(firstRoundTrip.rebuilds);
    expect(r.staticStructuresDrawn).toBe(firstRoundTrip.drawn);
  });

  it('draws nothing for off-screen structures, on either layer', () => {
    const m = base();
    const r = new ConnectorRenderer();
    const view = new Float64Array(4);
    r.viewBounds = view;
    // Looking at one corner of the base, zoomed in (viewHalf 512).
    const cx = -3800, cy = -3800;
    for (let i = 0; i <= 20; i++) r.update(m, phoneView(view, cx, cy, 512 * Math.pow(1.5, i / 20)), i * 16);
    const vb = view;
    const pad = 900; // a status bar / bolt sits just above its structure
    let outside = 0;
    let total = 0;
    const instr = (r.gfx.context as unknown as { instructions: { data: { path?: { instructions: { data: unknown[] }[] } } }[] }).instructions;
    for (const ins of instr) {
      for (const p of ins.data.path?.instructions ?? []) {
        const x = p.data[0], y = p.data[1];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        total++;
        if (x < vb[0]! - pad || x > vb[2]! + pad || y < vb[1]! - pad || y > vb[3]! + pad) outside++;
      }
    }
    expect(total).toBeGreaterThan(0); // the on-screen blueprints still draw
    expect(outside).toBe(0);
    // The static layer only ever drew the chunks near the view.
    expect(r.staticStructuresDrawn).toBeLessThan(m.structures!.size / 3);
  });

  it('with no view rect (worker probe, tests) everything draws as before', () => {
    const m = base();
    const r = new ConnectorRenderer();
    r.update(m, 0.2, 0);
    expect(r.staticRebuilds).toBe(1);
    expect(r.staticStructuresDrawn).toBe(m.structures!.size);
  });
});
