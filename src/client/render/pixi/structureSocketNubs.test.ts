/**
 * Structure restyle 0d slice 10: socket nubs drawn from the one socket list,
 * lit by `connSockSelf`, cached per (kind, used mask) and per structure, and
 * the per-family inner-channel hook (default: nothing).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Container, Matrix, Point } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import {
  innerChannelFor, MAX_NUB_SOCKETS, noInnerChannel, NUB_IN, NUB_OUT, nubStats, socketNubContext, socketNubLocal,
  socketNubsOf, socketUsedMask, STRUCTURE_INNER_CHANNELS, updateSocketNubs, drawSocketNubs, type InnerChannelHook,
} from './structureSocketNubs.js';
import { SOCKET_ACCENT } from './connectorCables.js';
import type { LinePath } from './connectorLineLooks.js';
import { structureSockets, structureSocketToWorld, type MutStructureSocket } from '../../../shared-types/structureKinds.js';
import { CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { POSE_RING_DEPTH, type PoseRingEntry, type RenderMirror, type StructureRenderState, type SwarmRenderState } from '../../../core/contracts/IRenderer.js';

/** A LinePath that records segments and the stroke each one got. */
interface Seg { x0: number; y0: number; x1: number; y1: number; color: number; alpha: number }
function recorder(): { g: LinePath; segs: Seg[] } {
  const segs: Seg[] = [];
  let open: Array<[number, number, number, number]> = [];
  let px = 0, py = 0;
  const g = {
    moveTo(x: number, y: number) { px = x; py = y; return g; },
    lineTo(x: number, y: number) { open.push([px, py, x, y]); px = x; py = y; return g; },
    stroke(s: { color: number; alpha: number }) {
      for (const [x0, y0, x1, y1] of open) segs.push({ x0, y0, x1, y1, color: s.color, alpha: s.alpha });
      open = [];
      return g;
    },
  };
  return { g: g as unknown as LinePath, segs };
}

function st(connSockSelf: number[]): StructureRenderState {
  return { powered: true, netPower: 1, connTo: connSockSelf.map((_, i) => 100 + i), connSockSelf, built: true, buildPct: 1, deconstructPct: 0 };
}

afterEach(() => { for (const k of Object.keys(STRUCTURE_INNER_CHANNELS)) delete STRUCTURE_INNER_CHANNELS[k as keyof typeof STRUCTURE_INNER_CHANNELS]; });

describe('socket nub positions', () => {
  it('under the sprite transform each nub sits on structureSocketToWorld (Y-flipped)', () => {
    const cx = 1234, cy = -567, angle = 0.83;
    const m = new Matrix().rotate(-angle).translate(cx, -cy); // sprite: rotation -angle at (cx, -cy)
    const loc: MutStructureSocket = { x: 0, y: 0, nx: 0, ny: 0 };
    const w: MutStructureSocket = { x: 0, y: 0, nx: 0, ny: 0 };
    for (const kind of ['solar', 'reactor', 'connector', 'capital']) {
      for (const s of structureSockets(kind)) {
        socketNubLocal(s, loc);
        const p = m.apply(new Point(loc.x, loc.y));
        structureSocketToWorld(s, cx, cy, angle, w);
        expect(p.x).toBeCloseTo(w.x, 6);
        expect(p.y).toBeCloseTo(-w.y, 6);
        // The normal turns the same way.
        const n = m.apply(new Point(loc.x + loc.nx, loc.y + loc.ny));
        expect(n.x - p.x).toBeCloseTo(w.nx, 6);
        expect(n.y - p.y).toBeCloseTo(-w.ny, 6);
      }
    }
  });

  it('draws one nub per socket, straddling the edge along the outward normal', () => {
    const list = structureSockets('solar');
    const { g, segs } = recorder();
    drawSocketNubs(g, 'solar', 0);
    const loc: MutStructureSocket = { x: 0, y: 0, nx: 0, ny: 0 };
    for (const s of list) {
      socketNubLocal(s, loc);
      // The outline stroke of the plate runs from NUB_IN inside to NUB_OUT outside.
      const hit = segs.some((q) => Math.abs(q.x0 - (loc.x - loc.nx * NUB_IN)) < 1e-9 && Math.abs(q.y0 - (loc.y - loc.ny * NUB_IN)) < 1e-9
        && Math.abs(q.x1 - (loc.x + loc.nx * NUB_OUT)) < 1e-9 && Math.abs(q.y1 - (loc.y + loc.ny * NUB_OUT)) < 1e-9);
      expect(hit).toBe(true);
    }
  });

  it('connector hub: six nubs, one on each face of its flat-top hex (the socket points)', () => {
    const list = structureSockets('connector');
    expect(list.length).toBe(6);
    // Flat-top hex: one face straight up, one straight down; normals 60° apart,
    // every socket the same distance (the apothem) out from the centre.
    const angles = list.map((s) => Math.round((Math.atan2(s.ny, s.nx) * 180) / Math.PI + 360) % 360).sort((a, b) => a - b);
    expect(angles).toEqual([30, 90, 150, 210, 270, 330]);
    const r0 = Math.hypot(list[0]!.x, list[0]!.y);
    for (const s of list) {
      expect(Math.hypot(s.x, s.y)).toBeCloseTo(r0, 6);
      expect(s.x / r0).toBeCloseTo(s.nx, 6); // face midpoint lies on its own normal
      expect(s.y / r0).toBeCloseTo(s.ny, 6);
    }
    const { g, segs } = recorder();
    drawSocketNubs(g, 'connector', 0);
    const loc: MutStructureSocket = { x: 0, y: 0, nx: 0, ny: 0 };
    // Each nub's plate outline is the first stroke of its nub: one per socket.
    const plates = segs.filter((q) => list.some((s) => {
      socketNubLocal(s, loc);
      return Math.abs(q.x0 - (loc.x - loc.nx * NUB_IN)) < 1e-9 && Math.abs(q.y0 - (loc.y - loc.ny * NUB_IN)) < 1e-9
        && Math.abs(q.x1 - (loc.x + loc.nx * NUB_OUT)) < 1e-9 && Math.abs(q.y1 - (loc.y + loc.ny * NUB_OUT)) < 1e-9;
    }));
    expect(plates.length).toBe(6);
  });

  it('shield gate / airlock (post sockets) get no nub', () => {
    for (const kind of ['shield_gate', 'shield_airlock']) {
      const { g, segs } = recorder();
      drawSocketNubs(g, kind, 0b11);
      expect(segs.length).toBe(0);
    }
  });
});

describe('used vs free follows connSockSelf', () => {
  it('socketUsedMask sets the bit of each own-end socket, ignoring no-socket links', () => {
    expect(socketUsedMask(undefined)).toBe(0);
    expect(socketUsedMask([])).toBe(0);
    expect(socketUsedMask([2, CABLE_NO_SOCKET, 5])).toBe((1 << 2) | (1 << 5));
    expect(socketUsedMask([31])).toBe(2 ** 31);
    expect(socketUsedMask([MAX_NUB_SOCKETS])).toBe(0);
  });

  it('only used sockets get the lit accent', () => {
    const lit = (mask: number): number => {
      const { g, segs } = recorder();
      drawSocketNubs(g, 'solar', mask);
      return segs.filter((q) => q.color === SOCKET_ACCENT && q.alpha > 0.9).length;
    };
    expect(lit(0)).toBe(0);
    expect(lit(socketUsedMask([1]))).toBe(1);
    expect(lit(socketUsedMask([0, 3, 4]))).toBe(3);
  });
});

describe('per-structure cache', () => {
  it('swaps the shared context only when the used set changes; same kind + mask share one context', () => {
    const a = new Container(), b = new Container();
    updateSocketNubs(a, 'reactor', st([1]));
    const g = socketNubsOf(a)!;
    expect(g.parent).toBe(a);
    const ctx1 = g.context;
    const builds = nubStats.contextBuilds, swaps = nubStats.swaps;
    for (let i = 0; i < 5; i++) updateSocketNubs(a, 'reactor', st([1]));
    expect(nubStats.swaps).toBe(swaps);
    expect(socketNubsOf(a)).toBe(g);
    expect(a.children.filter((c) => c.label === 'socketNubs').length).toBe(1);
    updateSocketNubs(b, 'reactor', st([1]));
    expect(socketNubsOf(b)!.context).toBe(ctx1);
    expect(nubStats.contextBuilds).toBe(builds);
    // A new cable in socket 4: a.s nubs redraw (new context), once.
    updateSocketNubs(a, 'reactor', st([1, 4]));
    expect(nubStats.swaps).toBe(swaps + 1);
    expect(g.context).not.toBe(ctx1);
    expect(g.context).toBe(socketNubContext('reactor', socketUsedMask([1, 4])));
    updateSocketNubs(a, 'reactor', st([1, 4]));
    expect(nubStats.swaps).toBe(swaps + 1);
    // The cable goes: back to the first context.
    updateSocketNubs(a, 'reactor', st([1]));
    expect(g.context).toBe(ctx1);
  });

  it('sits under the build-ETA text', () => {
    const s = new Container();
    const body = new Container(); const eta = new Container(); eta.label = 'buildEta';
    s.addChild(body, eta);
    updateSocketNubs(s, 'solar', st([]));
    expect(s.getChildIndex(socketNubsOf(s)!)).toBe(1);
    expect(s.getChildIndex(eta)).toBe(2);
  });
});

describe('inner-channel hook', () => {
  it('defaults to a no-op; a family hook is called once per USED socket, in the local frame', () => {
    expect(innerChannelFor('solar')).toBe(noInnerChannel);
    expect(innerChannelFor('not_a_kind')).toBe(noInnerChannel);
    const calls: Array<[number, number, number]> = [];
    const hook: InnerChannelHook = (_g, s, i) => { calls.push([i, s.x, s.y]); };
    STRUCTURE_INNER_CHANNELS.power = hook;
    expect(innerChannelFor('solar')).toBe(hook);
    expect(innerChannelFor('smelter')).toBe(noInnerChannel);
    const { g } = recorder();
    drawSocketNubs(g, 'solar', socketUsedMask([0, 2]));
    const list = structureSockets('solar');
    expect(calls).toEqual([[0, list[0]!.x, -list[0]!.y], [2, list[2]!.x, -list[2]!.y]]);
  });
});

// ── Through the swarm updater: flag off draws nothing new ──────────────────

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}
function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0, radius: 36, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}
function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(), sprites: new Map<string, Graphics>(), mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 }, remoteHitTargets: new Set<string>(), localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(), structureMountAngles: new Map<string, number[]>(), spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(), art: { art: null, handles: new Map(), sunAz: 0 }, slewDtSec: 100,
  };
}
function mirror(): RenderMirror {
  return {
    swarm: new Map([[7, structureEntry('solar', 0, 0)], [8, structureEntry('connector', 400, 0)]]),
    structures: new Map([[7, st([0])], [8, st([3])]]),
  } as unknown as RenderMirror;
}

describe('updateSwarmSprites with socket nubs', () => {
  it('flag off: no nub child on any structure', () => {
    const ctx = makeCtx();
    updateSwarmSprites(mirror(), ctx);
    for (const s of ctx.sprites.values()) {
      expect(socketNubsOf(s)).toBeUndefined();
      expect(s.children.some((c) => c.label === 'socketNubs')).toBe(false);
    }
  });

  it('flag on: each structure carries its nubs, drawn for its used sockets', () => {
    const ctx = makeCtx();
    ctx.socketNubs = true;
    updateSwarmSprites(mirror(), ctx);
    const solar = ctx.sprites.get('swarm-7')!, conn = ctx.sprites.get('swarm-8')!;
    expect(socketNubsOf(solar)!.context).toBe(socketNubContext('solar', 1));
    expect(socketNubsOf(conn)!.context).toBe(socketNubContext('connector', 1 << 3));
  });
});
