/**
 * Structure restyle 1g — `?lineLook=pipe|cable|conduit` line looks on the
 * connector web. Locks: the flag parse, the default (no flag) still draws
 * today's single thin stroke per idle edge, and every look builds its static
 * body and per-frame flow without error.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { DEFAULT_LINE_LOOK, LINE_LOOKS, lineLookScale, mixColor, readLineLook } from './connectorLineLooks.js';
import { CONNECTOR_IDLE_ALPHA, CONNECTOR_IDLE_COLOR } from './connectorVisual.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { CABLE_POINTS } from './connectorCables.js';
import {
  CABLE_CURVE_FLOATS, CABLE_NO_SOCKET, flattenLinkCable, makeCableBox, makeCableSocketPick, pickCableSocketPair,
} from '../../../core/structures/cableCurve.js';
import type { GridNode } from '../../../core/structures/Grid.js';
import { getStructureKind, structureSockets, structureSocketToWorld } from '../../../shared-types/structureKinds.js';
import { blankGridNode, structureMirrorToGridNode } from '../../structures/mirrorToGridNode.js';

/** Three connector nodes in a row: edges 1–2 and 2–3. */
function row(flowing: boolean): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (let i = 1; i <= 3; i++) {
    swarm.set(i, {
      x: (i - 2) * 400, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: 46, kind: 2, shipKind: 'connector', sleeping: true, lastUpdateTick: 0,
    } as unknown as SwarmRenderState);
    structures.set(i, { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: false } as unknown as StructureRenderState);
  }
  structures.get(1)!.connTo.push(2);
  structures.get(2)!.connTo.push(1, 3);
  structures.get(3)!.connTo.push(2);
  const gridFlashes = flowing ? new Map([[1 * 65536 + 2, 1e12]]) : undefined;
  return { swarm, structures, gridFlashes } as unknown as RenderMirror;
}

interface Instr { action: string; data: { style: { color: number; alpha: number; width: number } } }
const instructions = (g: { context: unknown }): Instr[] => (g.context as { instructions: Instr[] }).instructions;

describe('readLineLook (structure restyle 1g)', () => {
  it('parses the three looks; absent or unknown = the cable default', () => {
    expect(readLineLook('?lineLook=pipe')).toBe('pipe');
    expect(readLineLook('?style=machined&lineLook=cable&dpr=1')).toBe('cable');
    expect(readLineLook('&lineLook=conduit')).toBe('conduit');
    expect(DEFAULT_LINE_LOOK).toBe('cable');
    expect(readLineLook('')).toBe(DEFAULT_LINE_LOOK);
    expect(readLineLook('?room=rig-home')).toBe(DEFAULT_LINE_LOOK);
    expect(readLineLook('?lineLook=')).toBe(DEFAULT_LINE_LOOK);
    expect(readLineLook('?lineLook=rope')).toBe(DEFAULT_LINE_LOOK);
    expect(readLineLook('?lineLook=piped')).toBe(DEFAULT_LINE_LOOK);
    expect(readLineLook('?xlineLook=pipe')).toBe(DEFAULT_LINE_LOOK);
  });
  it('lineLook=off picks the old thin line', () => {
    expect(readLineLook('?lineLook=off')).toBeNull();
    expect(readLineLook('?room=x&lineLook=off&dpr=1')).toBeNull();
    expect(readLineLook('?lineLook=offx')).toBe(DEFAULT_LINE_LOOK);
  });

  it('blends colours and floors the size when zoomed out', () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lineLookScale('pipe', 1)).toBe(1);
    expect(lineLookScale('pipe', 0.05)).toBeGreaterThan(1);
  });
});

describe('ConnectorRenderer line looks (structure restyle 1g)', () => {
  it('default (no flag) draws one thin idle stroke per edge, as before', () => {
    const r = new ConnectorRenderer();
    expect(r.lineLook).toBeNull();
    r.update(row(false), 0.5, 0);
    const strokes = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      expect(s.data.style.color).toBe(CONNECTOR_IDLE_COLOR);
      expect(s.data.style.alpha).toBeCloseTo(CONNECTOR_IDLE_ALPHA);
      expect(s.data.style.width).toBe(2); // max(1 / 0.5, 1)
    }
  });

  it('default flowing edge keeps glow + core + comet on the per-frame layer', () => {
    const r = new ConnectorRenderer();
    r.update(row(true), 0.5, 100);
    expect(instructions(r.gfx).filter((i) => i.action === 'stroke')).toHaveLength(3);
  });

  for (const look of LINE_LOOKS) {
    it(`${look}: builds a richer static body and a per-frame flow`, () => {
      const r = new ConnectorRenderer();
      r.lineLook = look;
      expect(() => r.update(row(true), 0.5, 100)).not.toThrow();
      const body = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
      expect(body.length).toBeGreaterThan(2 * 3);
      for (const s of body) {
        expect(Number.isFinite(s.data.style.width) && s.data.style.width > 0).toBe(true);
      }
      expect(instructions(r.gfx).filter((i) => i.action === 'stroke').length).toBeGreaterThan(0);
      // Idle web: no flow drawn per frame.
      const idle = new ConnectorRenderer();
      idle.lineLook = look;
      idle.update(row(false), 0.05, 0);
      expect(instructions(idle.gfx).filter((i) => i.action === 'stroke')).toHaveLength(0);
      expect(instructions(idle.staticGfx).length).toBeGreaterThan(0);
    });
  }

  /** Stroke-sequence digest of one look's static body + flow (idle and flowing). */
  function digest(look: 'pipe' | 'conduit'): string {
    const out: string[] = [];
    for (const [flowing, scale] of [[false, 0.5], [true, 0.5], [false, 0.05]] as const) {
      const r = new ConnectorRenderer();
      r.lineLook = look;
      r.update(row(flowing), scale, 100);
      for (const g of [r.staticGfx, r.gfx]) {
        for (const i of instructions(g)) {
          if (i.action !== 'stroke') continue;
          const s = i.data.style;
          out.push(`${s.color.toString(16)}/${s.alpha.toFixed(4)}/${s.width.toFixed(4)}`);
        }
      }
    }
    return out.join(' ');
  }

  it('pipe and conduit strokes are unchanged by the cable upgrade (1i)', () => {
    expect(digest('pipe')).toMatchSnapshot();
    expect(digest('conduit')).toMatchSnapshot();
  });
});

describe('cable look upgrade (structure restyle 1i)', () => {
  it('builds at every zoom: shadow, cradles, strands, lashings, collars, flow', () => {
    for (const scale of [0.02, 0.05, 0.2, 0.5, 1, 2]) {
      const r = new ConnectorRenderer();
      r.lineLook = 'cable';
      expect(() => r.update(row(true), scale, 100)).not.toThrow();
      const body = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
      for (const s of body) {
        expect(Number.isFinite(s.data.style.width) && s.data.style.width > 0).toBe(true);
        expect(Number.isFinite(s.data.style.alpha)).toBe(true);
      }
      const flow = instructions(r.gfx).filter((i) => i.action === 'stroke');
      expect(flow.length).toBeGreaterThanOrEqual(3); // bleed, lit core, band
    }
  });

  it('a long run gets cradles, lashings and collars; the body is much heavier than the old 7 strokes', () => {
    const r = new ConnectorRenderer();
    r.lineLook = 'cable';
    r.update(row(false), 0.5, 0);
    const perEdge = instructions(r.staticGfx).filter((i) => i.action === 'stroke').length / 2;
    // 2 shadows + 6 cradle + 9 strand + 2 lashing + 4 clamp + 4 collar.
    expect(perEdge).toBe(27);
    // The bundle is wider on screen than the old cable (~12 world units).
    const widest = Math.max(...instructions(r.staticGfx).filter((i) => i.action === 'stroke').map((i) => i.data.style.width));
    expect(widest).toBeGreaterThan(16);
  });

  it('a run too short for stations still draws strands, no stations', () => {
    const mirror = row(false);
    for (const [id, s] of (mirror.swarm as Map<number, SwarmRenderState>)) (s as { x: number }).x = (id - 2) * 30;
    const r = new ConnectorRenderer();
    r.lineLook = 'cable';
    r.update(mirror, 0.5, 0);
    const perEdge = instructions(r.staticGfx).filter((i) => i.action === 'stroke').length / 2;
    expect(perEdge).toBe(1 + 9);
  });
});

describe('socket cables (structure-restyle 0d slice 8)', () => {
  /** A solar panel (turned a quarter) linked to a connector, sockets picked
   *  by core's rule; plus a fence link between two shield pylons. */
  function base(): { mirror: RenderMirror; nodes: Map<string, GridNode>; sa: number; sb: number } {
    const placed: Array<[number, string, number, number, number]> = [
      [1, 'solar', 0, 0, Math.PI / 2], [2, 'connector', 380, 140, 0],
      [3, 'shield_pylon', -600, -400, 0], [4, 'shield_pylon', -200, -400, 0],
    ];
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    const nodes = new Map<string, GridNode>();
    for (const [id, kind, x, y, angle] of placed) {
      const e = {
        x, y, vx: 0, vy: 0, angle, angvel: 0, prevX: x, prevY: y, prevAngle: angle, prevArrivalMs: 0, latestArrivalMs: 0,
        poseRing: [], ringHead: 0, radius: getStructureKind(kind).radius, kind: 2, shipKind: kind, sleeping: true, lastUpdateTick: 0,
      } as unknown as SwarmRenderState;
      swarm.set(id, e);
      const st = {
        powered: true, netPower: 50, connTo: [], connSockSelf: [], connSockOther: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: false,
      } as unknown as StructureRenderState;
      structures.set(id, st);
      nodes.set(String(id), structureMirrorToGridNode(String(id), st, e, blankGridNode()));
    }
    const pick = makeCableSocketPick();
    expect(pickCableSocketPair(nodes.get('1')!, nodes.get('2')!, 600, nodes, undefined, pick)).toBeNull();
    const link = (a: number, b: number, sa: number, sb: number): void => {
      const A = structures.get(a)!, B = structures.get(b)!;
      A.connTo.push(b); A.connSockSelf!.push(sa); A.connSockOther!.push(sb);
      B.connTo.push(a); B.connSockSelf!.push(sb); B.connSockOther!.push(sa);
    };
    link(1, 2, pick.a, pick.b);
    link(3, 4, CABLE_NO_SOCKET, CABLE_NO_SOCKET);
    return { mirror: { swarm, structures } as unknown as RenderMirror, nodes, sa: pick.a, sb: pick.b };
  }

  interface PathInstr { action: string; data: { path: { instructions: Array<{ action: string; data: number[] }> } } }
  /** The points of every stroked path on `g` that has `n` points. */
  function strokedPaths(g: { context: unknown }, n: number): number[][] {
    const out: number[][] = [];
    for (const i of (g.context as { instructions: PathInstr[] }).instructions) {
      if (i.action !== 'stroke') continue;
      const pts: number[] = [];
      for (const p of i.data.path.instructions) if (p.action === 'moveTo' || p.action === 'lineTo') pts.push(p.data[0]!, p.data[1]!);
      if (pts.length === n * 2) out.push(pts);
    }
    return out;
  }

  it('the drawn cable is core flattenLinkCable between the stored sockets (y flipped)', () => {
    const { mirror, nodes, sa, sb } = base();
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.update(mirror, 0.5, 0);
    const world = new Float64Array(CABLE_CURVE_FLOATS);
    flattenLinkCable(nodes.get('1')!, sa, nodes.get('2')!, sb, world, makeCableBox());
    const expected = Array.from(world, (v, i) => (i % 2 === 1 ? -v : v));
    const c = r.cables.peek(1 * 65536 + 2)!;
    expect(c.socketed).toBe(true);
    expect(Array.from(c.poly)).toEqual(expected);
    // The outline / sheath / core strokes run exactly that polyline.
    const drawn = strokedPaths(r.staticGfx, CABLE_POINTS).filter((p) => p[0] === expected[0] && p[1] === expected[1]);
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (const p of drawn) expect(p).toEqual(expected);
    // It leaves the socket along the socket's outward normal.
    const n = { x: 0, y: 0, nx: 0, ny: 0 };
    structureSocketToWorld(structureSockets('solar')[sa]!, 0, 0, Math.PI / 2, n);
    const dx = world[2]! - world[0]!, dy = world[3]! - world[1]!;
    expect((dx * n.nx + dy * n.ny) / Math.hypot(dx, dy)).toBeGreaterThan(0.99);
  });

  it('a fence link stays straight post to post, no collars', () => {
    const { mirror } = base();
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.update(mirror, 0.5, 0);
    const c = r.cables.peek(3 * 65536 + 4)!;
    expect(c.socketed).toBe(false);
    for (let i = 0; i < CABLE_POINTS; i++) {
      expect(c.poly[i * 2 + 1]).toBeCloseTo(400); // pixi y = -(-400)
      expect(c.poly[i * 2]).toBeCloseTo(-600 + (400 * i) / (CABLE_POINTS - 1));
    }
  });

  it('caches per link: no re-flatten on a redraw or zoom; a socket change re-lays that link', () => {
    const { mirror } = base();
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.update(mirror, 0.5, 0);
    expect(r.cables.flattens).toBe(2);
    expect(r.cables.size).toBe(2);
    const rebuilds = r.staticRebuilds;
    r.update(mirror, 0.5, 16);
    expect(r.staticRebuilds).toBe(rebuilds);
    r.update(mirror, 0.9, 32); // zoom: the body is redrawn, the curves are not re-flattened
    expect(r.staticRebuilds).toBe(rebuilds + 1);
    expect(r.cables.flattens).toBe(2);
    const before = Array.from(r.cables.peek(1 * 65536 + 2)!.poly);
    // The server re-picks the solar's socket.
    const st1 = mirror.structures.get(1)!, st2 = mirror.structures.get(2)!;
    const other = (st1.connSockSelf![0]! + 1) % structureSockets('solar').length;
    st1.connSockSelf![0] = other; st2.connSockOther![0] = other;
    r.update(mirror, 0.9, 48);
    expect(r.staticRebuilds).toBe(rebuilds + 2);
    expect(r.cables.flattens).toBe(3);
    expect(Array.from(r.cables.peek(1 * 65536 + 2)!.poly)).not.toEqual(before);
    // A link that goes away leaves the cache.
    for (const st of [st1, st2]) { st.connTo.length = 0; st.connSockSelf!.length = 0; st.connSockOther!.length = 0; }
    r.update(mirror, 0.9, 64);
    expect(r.cables.size).toBe(1);
  });

  it('a flowing link draws its flow along the same cached cable', () => {
    const { mirror } = base();
    (mirror as { gridFlashes?: Map<number, number> }).gridFlashes = new Map([[1 * 65536 + 2, 1e12]]);
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.update(mirror, 0.5, 100);
    const c = r.cables.peek(1 * 65536 + 2)!;
    const flow = strokedPaths(r.gfx, CABLE_POINTS);
    expect(flow.length).toBeGreaterThanOrEqual(2); // bleed + lit core
    for (const p of flow) expect(p).toEqual(Array.from(c.poly));
    expect(r.cables.flattens).toBe(2);
  });

  it('flag off: today\'s straight thin line, no cable cache', () => {
    const { mirror } = base();
    const r = new ConnectorRenderer();
    r.update(mirror, 0.5, 0);
    expect(r.cables.size).toBe(0);
    expect(instructions(r.staticGfx).filter((i) => i.action === 'stroke')).toHaveLength(2);
  });

  it('slice 9: flow frames redraw only the animated layer; the receiving collar flashes as comets arrive', () => {
    const { mirror } = base();
    const key = 1 * 65536 + 2;
    // Flow from the connector (2) into the solar (1): the solar end, the
    // polyline's first point, receives.
    Object.assign(mirror, { gridFlashes: new Map([[key, 1e12]]), gridFlowSrc: new Map([[key, 2]]) });
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.update(mirror, 0.5, 0);
    const rebuilds = r.staticRebuilds, flattens = r.cables.flattens;
    const c = r.cables.peek(key)!;
    let flashFrames = 0, frames = 0;
    for (let t = 50; t <= 6000; t += 50) {
      r.update(mirror, 0.5, t);
      frames++;
      if (strokedPaths(r.gfx, 2).some((p) => p[0] === c.poly[0] && p[1] === c.poly[1])) flashFrames++;
    }
    expect(r.staticRebuilds).toBe(rebuilds);
    expect(r.cables.flattens).toBe(flattens);
    expect(flashFrames).toBeGreaterThan(0);
    expect(flashFrames).toBeLessThan(frames / 2); // a brief flash per arrival, not a steady glow
  });

  it('flag off: a flowing link keeps today\'s straight comet, no cables', () => {
    const { mirror } = base();
    (mirror as { gridFlashes?: Map<number, number> }).gridFlashes = new Map([[1 * 65536 + 2, 1e12]]);
    const r = new ConnectorRenderer();
    r.update(mirror, 0.5, 100);
    expect(r.cables.size).toBe(0);
    // Glow, line and comet stay straight two-point strokes; nothing runs a cable.
    expect(strokedPaths(r.gfx, 2).length).toBeGreaterThanOrEqual(3);
    expect(strokedPaths(r.gfx, CABLE_POINTS)).toHaveLength(0);
  });
});
