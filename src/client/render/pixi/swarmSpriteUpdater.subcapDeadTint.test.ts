/**
 * Sub-cap break-up, round-2 hostile review (2026-11-13, fleet-fight take
 * `film/subcap-2`, crop f00588): "most robot wreckage turns dark maroon, but
 * nearly every dead robot leaves one or two BRIGHT full-colour pink pieces
 * (unlabelled, no turret) that stay bright for seconds and read as live
 * ships". EVERY sub-cap piece must look dead from the first frame it is drawn (its warm cut-edge glow the only bright part), at the latest within `glowSeconds` of its
 * death, whatever path it takes to the screen: pieces of a wreck arriving at
 * different times (out-of-interest binary cadence, the descriptor on another
 * channel), a piece first drawn plain and rebuilt when the art is ready, a
 * piece with no cut edges (no glow), a hit flash during and after the glow,
 * baked and GPU-lit art.
 *
 * "Looks dead" = the colour the art is drawn with (its own tint times every
 * ancestor's, the way Pixi multiplies a container's tint down) is no brighter
 * than the profile's `deadTint`, measured channel by channel.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, GlProgram, Mesh, Rectangle, Texture, TextureSource } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { WreckArtState, WreckPieceSprite, coolWreckInfo } from './wreckArt.js';
import { litPass } from '../art/litPass.js';
import { LitShipMesh } from '../art/litShipShader.js';
import { LOOK_NIGHT } from '../art/lightingSettings.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';
import type { ArtHandle, ArtService, ShipArt } from '../art/ArtService.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';

// No WebGL in node: the lit shader's program is never compiled here.
vi.spyOn(GlProgram, 'from').mockImplementation(() => ({}) as GlProgram);

const SUB = DESTRUCTION_PROFILES.subcap.fx;
const DEAD = SUB.deadTint!;
const GLOW_MS = SUB.glowSeconds * 1000;
const TICK_MS = 1000 / 60;
const FRAME_MS = 16;

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

function bakedArt(): ShipArt {
  const frames: Texture[] = [];
  for (let s = 0; s < 16; s++) frames.push(new Texture({ source: new TextureSource({ width: 64, height: 64 }) }));
  return { frames, w: 64, h: 64, tiles: 1, tileH: 64, density: 1, nozzles: [], navLights: [] };
}

function litArt(): ShipArt {
  const page = new TextureSource({ width: 1024, height: 1024 });
  const frames = [new Texture({ source: page, frame: new Rectangle(64, 64, 64, 64) })];
  return { frames, w: 64, h: 64, tiles: 1, tileH: 64, density: 1, nozzles: [], navLights: [], lit: { w: 64, h: 64, ppu: 1, maxH: 10, emisMax: 1 } };
}

/** An art service whose handles turn `ready` only once `ready.on` is set
 *  (the dead ship's art arriving after its first pieces are drawn). */
function artService(art: ShipArt, ready: { on: boolean }): ArtService {
  const handles = new Map<string, ArtHandle>();
  return {
    lightRig: {},
    ship: (id: string) => {
      let h = handles.get(id);
      if (!h) {
        h = { key: id, job: { type: 'ship', id }, rig: {} as ArtHandle['rig'], state: 'pending', ship: null, struct: null };
        handles.set(id, h);
      }
      if (ready.on) { h.state = 'ready'; h.ship = art; }
      return h;
    },
  } as unknown as ArtService;
}

function makeCtx(art: ArtService | null, quality = 'high'): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Container>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art, handles: new Map(), sunAz: 0.4 },
    slewDtSec: 1 / 60,
    wrecks: new WreckGeometryStore(),
    wreckArt: new WreckArtState(() => {}, () => {}, () => 7, () => quality),
  } as SwarmSpriteCtx;
}

function desc(wreckId: number, parentKind: string, seed: number, deathTick: number): WreckDescriptor {
  return {
    wreckId, parentKind, seed, killX: 0, killY: -4,
    killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION, deathTick,
  };
}

function entry(d: WreckDescriptor, g: WreckPieceGeometry, i: number, tick: number, dx: number): SwarmRenderState {
  return {
    x: g.cx + dx, y: g.cy, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: g.cx + dx, prevY: g.cy, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: g.radius, kind: 4, shipKind: d.parentKind, componentIndex: i, wreckId: d.wreckId,
    sleeping: false, lastUpdateTick: tick,
  } as SwarmRenderState;
}

/** The colour a container's art is drawn with: its own tint times every
 *  ancestor's (Pixi v8 multiplies a container's tint into its children). */
function drawnTint(node: Container): number {
  let r = 255, g = 255, b = 255;
  for (let n: Container | null = node; n !== null; n = n.parent) {
    const t = n.tint as number;
    r = (r * ((t >> 16) & 255)) / 255; g = (g * ((t >> 8) & 255)) / 255; b = (b * (t & 255)) / 255;
  }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** No channel brighter than the dead tint (+1 for rounding). */
function looksDead(t: number): boolean {
  return ((t >> 16) & 255) <= ((DEAD >> 16) & 255) + 1 && ((t >> 8) & 255) <= ((DEAD >> 8) & 255) + 1 && (t & 255) <= (DEAD & 255) + 1;
}

/** Every art node of a piece (not its glow): the meshes or the plain polygon. */
function artNodes(p: WreckPieceSprite): Container[] {
  return p.children.filter((c) => !(c instanceof Mesh && (c as Mesh).texture === p.glowTexture()));
}

interface Plan {
  /** Wreck → its death tick and when (game ms after the start) its descriptor arrives. */
  wrecks: Array<{ d: WreckDescriptor; descAtMs: number; pieceAtMs: number[] }>;
  artReadyAtMs: number;
  /** Per frame: which piece keys flash (a hit). */
  flash: (key: string, tMs: number) => boolean;
}

/** Plays a fleet-fight-like stream for `durMs` and returns every
 *  (piece, time) where a piece `graceMs` or more past its first sight
 *  was drawn brighter than the dead look. */
function play(ctx: SwarmSpriteCtx, plan: Plan, durMs: number, T0: number, deathMsOf: (d: WreckDescriptor) => number, graceMs: number): string[] {
  const bad: string[] = [];
  const swarm = new Map<number, SwarmRenderState>();
  const wrecks = new Map<number, WreckDescriptor>();
  const mirror = { swarm, wrecks } as unknown as RenderMirror;
  for (let t = 0; t <= durMs; t += FRAME_MS) {
    const tick = Math.floor((T0 + t) / TICK_MS);
    let w = 0;
    for (const { d, descAtMs, pieceAtMs } of plan.wrecks) {
      if (t >= descAtMs) wrecks.set(d.wreckId, d);
      const geom = rebuildWreckPieces(d)!;
      geom.forEach((g, i) => {
        const id = 1000 + w * 10 + i;
        const at = pieceAtMs[i] ?? 0;
        if (t >= at) {
          const e = swarm.get(id) ?? entry(d, g, i, tick, w * 500);
          e.lastUpdateTick = tick;
          swarm.set(id, e);
        }
      });
      w++;
    }
    ctx.localHitTargets.clear();
    for (const id of swarm.keys()) if (plan.flash(`swarm-${id}`, t)) ctx.localHitTargets.add(`swarm-${id}`);
    ctx.fxNowMs = T0 + t;
    updateSwarmSprites(mirror, ctx);
    // The check, on every piece drawn this frame.
    w = 0;
    for (const { d } of plan.wrecks) {
      const geom = rebuildWreckPieces(d)!;
      for (let i = 0; i < geom.length; i++) {
        const key = `swarm-${1000 + w * 10 + i}`;
        const p = ctx.sprites.get(key);
        if (!(p instanceof WreckPieceSprite)) continue;
        if (T0 + t < deathMsOf(d) + graceMs) continue;
        const nodes = artNodes(p);
        if (nodes.length === 0) bad.push(`${key} at ${t} ms: no art`);
        for (const n of nodes) {
          const c = drawnTint(n);
          if (!looksDead(c)) bad.push(`${key} (${d.parentKind}, ${p.artMode()}) at ${t} ms: drawn #${c.toString(16)}, mesh #${(n.tint as number).toString(16)}, container #${(p.tint as number).toString(16)}`);
        }
      }
      w++;
    }
  }
  return bad;
}

describe('every sub-cap piece looks dead from its first frame (round-2 review)', () => {
  const T0 = 100_000;
  const tick0 = Math.floor(T0 / TICK_MS);
  // Several robot and drone wrecks dying at different times; pieces and
  // descriptors arriving out of step; the art arriving after 400 ms.
  function plan(): Plan {
    const kinds = ['robot-square', 'robot-hexagon', 'fighter', 'gunship', 'missile-frigate', 'robot-square'];
    return {
      wrecks: kinds.map((k, i) => ({
        d: desc(20 + i, k, 31 + i * 17, tick0 + i * 12),
        descAtMs: i * 200 + (i % 2 === 0 ? 0 : 150),
        pieceAtMs: [i * 200, i * 200 + 120 * (i % 3), i * 200 + 1500 * (i % 2)],
      })),
      artReadyAtMs: 400,
      // Flashes: on and off during the glow, then again well after it.
      flash: (key, t) => (key.charCodeAt(key.length - 1) + Math.floor(t / 48)) % 5 === 0,
    };
  }
  /** Death as the client sees it: first sight if within the glow window. */
  const firstSight = (p: Plan) => (d: WreckDescriptor): number => {
    const w = p.wrecks.find((x) => x.d === d)!;
    const seen = T0 + Math.max(w.descAtMs, Math.min(...w.pieceAtMs));
    const truth = d.deathTick! * TICK_MS;
    return seen - truth < GLOW_MS ? seen : truth;
  };

  for (const look of ['baked', 'lit', 'plain'] as const) {
    it(`${look} art: pieces arriving late, art arriving late, hit flashes during and after the glow`, () => {
      const ready = { on: false };
      const art = look === 'plain' ? null : artService(look === 'lit' ? litArt() : bakedArt(), ready);
      const prev = litPass.settings;
      if (look === 'lit') litPass.settings = LOOK_NIGHT;
      try {
        const ctx = makeCtx(art);
        const p = plan();
        const origFlash = p.flash;
        p.flash = (k, t) => { if (t >= p.artReadyAtMs) ready.on = true; return origFlash(k, t); };
        // Dead from the first frame drawn (grace 0): the glow is the only bright part.
        const bad = play(ctx, p, 3500, T0, firstSight(p), 0);
        expect(bad.slice(0, 12), `${bad.length} bright frames`).toEqual([]);
        if (look === 'lit') {
          const meshes = [...ctx.sprites.values()].flatMap((s) => s.children).filter((c) => c instanceof LitShipMesh);
          expect(meshes.length, 'the lit path ran').toBeGreaterThan(0);
        }
      } finally {
        litPass.settings = prev;
      }
    });
  }

  it('a piece with no cut edges (no glow at all) is dead from the first frame', () => {
    const d = desc(9, 'robot-square', 31, tick0);
    const g = rebuildWreckPieces(d)![0]!;
    const noCuts: WreckPieceGeometry = { ...g, cutEdges: g.cutEdges.map(() => false) };
    const ctx = makeCtx(null);
    const info = ctx.wreckArt!.infoFor(d, [noCuts], 0, { x: 0, y: 0, angle: 0 }, tick0 + 2, T0);
    const p = new WreckPieceSprite(noCuts, 'robot-square', bakedArt(), info, 0);
    p.update(T0, 0.4);
    expect(p.glowPositions()).toBeNull();
    for (const n of artNodes(p)) expect(looksDead(drawnTint(n)), `#${(n.tint as number).toString(16)}`).toBe(true);
    // And a late joiner's (cool) piece likewise.
    const cool = new WreckPieceSprite(g, 'robot-square', bakedArt(), coolWreckInfo(d), 0);
    for (const n of artNodes(cool)) expect(looksDead(drawnTint(n))).toBe(true);
  });
});
