/**
 * Capital destruction — the dying hull must stay drawn until its wreck pieces
 * are (invariant #13: written to fail first).
 *
 * Filmed bug (capital-breakup take B at 1×, hostile review 2026-11-13, frames
 * 18.0–18.4 s): "the cruiser is gone for ~0.5 s, and the kill blast and damage
 * number float over empty space. The hull then pops back already as cracked
 * wreck pieces." At 0.25× the gap was ~75 game ms; take A had none.
 *
 * Cause: the renderer swept the hull's sprite the frame its entity left the
 * mirror, but a wreck piece is drawn only once its binary pose AND its
 * `wrecks[]` descriptor have both arrived (two channels; out-of-interest
 * pieces ride the binary wire every 6 ticks). This drives the renderer's own
 * frame steps (death marks from `explodingShips`, `updateSwarmSprites`, the
 * sprite sweep, the hold's settle) through that sequence and asserts that
 * every frame draws either the whole hull or the whole wreck, and the
 * hand-over happens in one frame.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx, type SpriteBuildSig } from './swarmSpriteUpdater.js';
import { sweepUnseenSprites } from './spriteSweep.js';
import { DyingHullHold, DYING_HULL_HOLD_MS, dyingHoldMsFor, noteDyingHulls } from './dyingHullHold.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';
import { WreckPieceSprite } from './wreckArt.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

const HULL_X = 4000, HULL_Y = -350;
const DESC: WreckDescriptor = {
  wreckId: 9, parentKind: 'battleship', seed: 11, killX: 0, killY: -400,
  killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
};

function entry(kind: number, shipKind: string, x: number, y: number, radius: number, extra: Partial<SwarmRenderState> = {}): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius, kind, shipKind, sleeping: false, lastUpdateTick: 0, ...extra,
  } as SwarmRenderState;
}

/** One renderer frame, in the order `PixiRenderer.update` runs them. */
class Harness {
  readonly container = new Container();
  readonly sprites = new Map<string, Container>();
  readonly sigs = new Map<string, SpriteBuildSig>();
  readonly seen = new Set<string>();
  readonly hold = new DyingHullHold();
  readonly ctx: SwarmSpriteCtx;
  readonly mirror: RenderMirror;
  readonly swarm = new Map<number, SwarmRenderState>();
  constructor(capitalWrecks: boolean, subcapWrecks = false) {
    this.ctx = {
      shipContainer: this.container, sprites: this.sprites, mountVisuals: new MountVisualManager(),
      swarmPoseScratch: { x: 0, y: 0, angle: 0 }, remoteHitTargets: new Set(), localHitTargets: new Set(),
      seenScratch: this.seen, structureMountAngles: new Map(), spriteKinds: new Map(), spriteBuildSigs: this.sigs,
      art: { art: null, handles: new Map(), sunAz: 0 }, slewDtSec: 1 / 60, wrecks: new WreckGeometryStore(),
      dyingHulls: this.hold,
    } as SwarmSpriteCtx;
    this.mirror = { swarm: this.swarm, explodingShips: new Set<string>(), capitalWrecks, subcapWrecks } as unknown as RenderMirror;
  }
  frame(nowMs: number): void {
    this.seen.clear();
    this.ctx.fxNowMs = nowMs;
    noteDyingHulls(this.mirror.explodingShips, this.mirror.capitalWrecks, (id) => this.sigs.get(id)?.shipKind ?? undefined, this.hold, nowMs, this.mirror.subcapWrecks);
    updateSwarmSprites(this.mirror, this.ctx);
    sweepUnseenSprites(this.sprites, this.seen, (id, held) => { this.sigs.delete(id); if (held) this.ctx.mountVisuals.detachShip(id); else this.ctx.mountVisuals.removeShip(id); }, this.hold, nowMs);
    this.hold.settle(nowMs);
    this.mirror.explodingShips!.clear(); // App.tsx clears one-frame triggers after the frame
  }
  /** Drawn hull sprites (a non-piece ship in the container). */
  hullsDrawn(): number {
    let n = 0;
    for (const c of this.container.children) if (!(c instanceof WreckPieceSprite) && c.visible && !c.destroyed) n++;
    return n;
  }
  piecesDrawn(): number {
    let n = 0;
    for (const c of this.container.children) if (c instanceof WreckPieceSprite && c.visible && !c.destroyed) n++;
    return n;
  }
  /** What ColyseusClient.killSwarmEntity does on a `destroy` event. */
  kill(entityId: number): void {
    this.swarm.delete(entityId);
    this.mirror.explodingShips!.add(`swarm-${entityId}`);
  }
  addPieces(): number {
    const geom = rebuildWreckPieces(DESC);
    geom.forEach((g, i) => this.swarm.set(200 + i, entry(4, 'battleship', HULL_X + g.cx, HULL_Y + g.cy, g.radius, { componentIndex: i, wreckId: DESC.wreckId })));
    return geom.length;
  }
}

describe('a dying capital stays drawn until its wreck pieces are', () => {
  it('draws the hull or its pieces in EVERY frame from the kill to the hand-over', () => {
    const h = new Harness(true);
    h.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    let t = 1000;
    h.frame(t);
    expect(h.hullsDrawn(), 'the live battleship').toBe(1);

    // The destroy event: the hull leaves the mirror. Nothing of the wreck yet.
    h.kill(50);
    const timeline: string[] = [];
    const record = (label: string): void => { timeline.push(`${label}: hull ${h.hullsDrawn()}, pieces ${h.piecesDrawn()}`); };
    for (let f = 0; f < 3; f++) { h.frame(t += 16); record(`kill+${f}`); }
    // The binary pieces arrive (out-of-interest cadence), the descriptor not yet.
    const n = h.addPieces();
    for (let f = 0; f < 2; f++) { h.frame(t += 16); record(`pieces+${f}`); }
    // The snapshot carrying `wrecks[]` lands: the pieces become drawable.
    h.mirror.wrecks = new Map([[DESC.wreckId, DESC]]);
    h.frame(t += 16); record('descriptor');

    for (const line of timeline) expect(line, `every frame draws something:\n${timeline.join('\n')}`).not.toMatch(/hull 0, pieces 0/);
    // Same-frame hand-over: once the pieces are drawn the hull is gone.
    expect(timeline[timeline.length - 1]).toBe(`descriptor: hull 0, pieces ${n}`);
    for (const line of timeline.slice(0, -1)) expect(line).toMatch(/hull 1, pieces 0/);
  });

  // Filmed 2026-11-13 (after #540): the hold ended on the FIRST piece drawn,
  // but out-of-interest pieces (and every piece, for a spectator) reach the
  // binary wire at different ticks, so the middle chunk was drawn alone, then
  // the stern, then the bow. No frame may show a partial wreck.
  it('pieces arriving one per frame: every frame draws the full hull or ALL pieces, never a subset', () => {
    const h = new Harness(true);
    h.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    let t = 1000;
    h.frame(t);
    h.kill(50);
    h.mirror.wrecks = new Map([[DESC.wreckId, DESC]]); // the descriptor is already known
    const geom = rebuildWreckPieces(DESC);
    const n = geom.length;
    expect(n, 'the fixture wreck breaks into several pieces').toBeGreaterThan(1);
    const timeline: string[] = [];
    const record = (label: string): void => { timeline.push(`${label}: hull ${h.hullsDrawn()}, pieces ${h.piecesDrawn()}`); };
    h.frame(t += 16); record('kill');
    // Middle chunk first, then the rest one per frame (out of index order).
    const order = geom.map((_, i) => i).sort((a, b) => Math.abs(a - (n >> 1)) - Math.abs(b - (n >> 1)));
    for (const i of order) {
      const g = geom[i]!;
      h.swarm.set(200 + i, entry(4, 'battleship', HULL_X + g.cx, HULL_Y + g.cy, g.radius, { componentIndex: i, wreckId: DESC.wreckId }));
      h.frame(t += 16); record(`piece ${i}`);
    }
    h.frame(t += 16); record('after');
    const ok = new RegExp(`^[^:]+: (hull 1, pieces 0|hull 0, pieces ${n})$`);
    for (const line of timeline) expect(line, `full hull or all ${n} pieces in every frame:\n${timeline.join('\n')}`).toMatch(ok);
    expect(timeline[timeline.length - 1]).toBe(`after: hull 0, pieces ${n}`);
    expect(timeline[timeline.length - 2]).toBe(`piece ${order[n - 1]}: hull 0, pieces ${n}`);
  });

  it('pieces still missing at the deadline: the hull goes and the pieces that arrived show', () => {
    const h = new Harness(true);
    h.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    let t = 1000;
    h.frame(t);
    h.kill(50);
    h.mirror.wrecks = new Map([[DESC.wreckId, DESC]]);
    const g = rebuildWreckPieces(DESC)[0]!;
    h.swarm.set(200, entry(4, 'battleship', HULL_X + g.cx, HULL_Y + g.cy, g.radius, { componentIndex: 0, wreckId: DESC.wreckId }));
    h.frame(t += 16);
    expect(h.hullsDrawn()).toBe(1);
    expect(h.piecesDrawn(), 'a lone piece waits under the held hull').toBe(0);
    h.frame(t += DYING_HULL_HOLD_MS);
    expect(h.hullsDrawn()).toBe(0);
    expect(h.piecesDrawn()).toBe(1);
  });

  it('a lost wreck never leaves a ghost hull: the hold ends after the deadline', () => {
    const h = new Harness(true);
    h.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    let t = 1000;
    h.frame(t);
    h.kill(50);
    h.frame(t += 16);
    expect(h.hullsDrawn()).toBe(1);
    h.frame(t += DYING_HULL_HOLD_MS - 32);
    expect(h.hullsDrawn(), 'still waiting').toBe(1);
    h.frame(t += 32);
    expect(h.hullsDrawn(), 'gone at the deadline').toBe(0);
    expect(h.hold.heldCountNow()).toBe(0);
  });

  it('pieces of another kind, or far away, do not end the hold', () => {
    const h = new Harness(true);
    h.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    let t = 1000;
    h.frame(t);
    h.kill(50);
    // An older battleship wreck drifting 20 km away.
    const geom = rebuildWreckPieces(DESC);
    h.swarm.set(300, entry(4, 'battleship', HULL_X + 20_000, HULL_Y, geom[0]!.radius, { componentIndex: 0, wreckId: DESC.wreckId }));
    h.mirror.wrecks = new Map([[DESC.wreckId, DESC]]);
    h.frame(t += 16);
    expect(h.piecesDrawn()).toBe(1);
    expect(h.hullsDrawn(), 'a far wreck is not this hull\'s').toBe(1);
  });

  it('unchanged without a wreck: rooms that do not break capitals, non-capitals, and a capital that leaves without dying', () => {
    const off = new Harness(false);
    off.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    off.frame(1000);
    off.kill(50);
    off.frame(1016);
    expect(off.hullsDrawn(), 'capitalWrecks off').toBe(0);

    const fighter = new Harness(true);
    fighter.swarm.set(51, entry(1, 'fighter', 0, 0, 12));
    fighter.frame(1000);
    fighter.kill(51);
    fighter.frame(1016);
    expect(fighter.hullsDrawn(), 'a fighter leaves no wreck').toBe(0);

    const leaves = new Harness(true);
    leaves.swarm.set(52, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    leaves.frame(1000);
    leaves.swarm.delete(52); // e.g. warped out of the sector: no destroy event
    leaves.frame(1016);
    expect(leaves.hullsDrawn(), 'no death, no hold').toBe(0);
  });
});

describe('a dying sub-capital (subcapWrecks): the same hold, brief', () => {
  const SUB_DESC: WreckDescriptor = {
    wreckId: 12, parentKind: 'fighter', seed: 31, killX: 0, killY: -4,
    killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
  };
  const FX = 200, FY = 100;

  it('holds the fighter until its pieces draw, then hands over in one frame', () => {
    const h = new Harness(false, true);
    h.swarm.set(60, entry(1, 'fighter', FX, FY, 12));
    let t = 1000;
    h.frame(t);
    h.kill(60);
    h.frame(t += 16);
    expect(h.hullsDrawn(), 'held: no blank frame').toBe(1);
    const geom = rebuildWreckPieces(SUB_DESC);
    geom.forEach((g, i) => h.swarm.set(300 + i, entry(4, 'fighter', FX + g.cx, FY + g.cy, g.radius, { componentIndex: i, wreckId: SUB_DESC.wreckId })));
    h.mirror.wrecks = new Map([[SUB_DESC.wreckId, SUB_DESC]]);
    h.frame(t += 16);
    expect(h.hullsDrawn()).toBe(0);
    expect(h.piecesDrawn()).toBe(geom.length);
  });

  it('a lost sub-cap wreck lets go after the profile\'s brief deadline, not the capital\'s', () => {
    const brief = DESTRUCTION_PROFILES.subcap.fx.dyingHoldMs;
    expect(brief).toBeLessThan(DYING_HULL_HOLD_MS);
    const h = new Harness(false, true);
    h.swarm.set(60, entry(1, 'fighter', FX, FY, 12));
    let t = 1000;
    h.frame(t);
    h.kill(60);
    h.frame(t += 16);
    expect(h.hullsDrawn()).toBe(1);
    h.frame(t += brief);
    expect(h.hullsDrawn(), 'gone at the sub-cap deadline').toBe(0);
  });

  /**
   * Owner 2026-11-13, after the v4 debris film: "The darkened scrap just
   * doesn't look right, what's the logic? Why would it darken when destroyed?
   * It should just be broken, same brightness?" A held sub-cap hull is drawn
   * at the art's normal tint (white multiply) for the whole (brief) hold:
   * never darkened, and never frozen mid hit-flash (round-2 review: no sweep
   * updates a held sprite, so a flash it died wearing would stick). A
   * capital's hold is unchanged.
   */
  it('a held sub-cap hull keeps its normal brightness (no dead tint, no frozen flash), and is brief', () => {
    expect(DESTRUCTION_PROFILES.subcap.fx.deadTint, 'no dead tint').toBeNull();
    expect(DESTRUCTION_PROFILES.subcap.fx.dyingHoldMs, 'brief: pieces take over fast').toBeLessThanOrEqual(250);
    for (const flashedAtDeath of [true, false]) {
      const h = new Harness(false, true);
      h.swarm.set(60, entry(1, 'fighter', FX, FY, 12));
      let t = 1000;
      h.frame(t);
      // It was being hit as it died: the live sprite wears the flash.
      if (flashedAtDeath) h.ctx.localHitTargets.add('swarm-60');
      h.frame(t += 16);
      h.ctx.localHitTargets.clear();
      h.kill(60);
      for (let f = 0; f < 3; f++) {
        h.frame(t += 16);
        const held = h.container.children.filter((c) => !(c instanceof WreckPieceSprite) && c.visible && !c.destroyed);
        expect(held).toHaveLength(1);
        expect(held[0]!.tint, `normal tint while held (flashed at death: ${flashedAtDeath})`).toBe(0xffffff);
      }
    }
    // A capital's held hull keeps its look (unchanged).
    const c = new Harness(true);
    c.swarm.set(50, entry(1, 'battleship', HULL_X, HULL_Y, 300));
    c.frame(1000);
    c.kill(50);
    c.frame(1016);
    const cap = c.container.children.filter((x) => !(x instanceof WreckPieceSprite) && x.visible && !x.destroyed);
    expect(cap).toHaveLength(1);
    expect(cap[0]!.tint).toBe(0xffffff);
  });

  it('subcapWrecks alone does not hold a capital, and capitalWrecks alone does not hold a fighter', () => {
    expect(dyingHoldMsFor(false, 'battleship', true)).toBe(0);
    expect(dyingHoldMsFor(true, 'fighter', false)).toBe(0);
    expect(dyingHoldMsFor(true, 'battleship', false)).toBe(DYING_HULL_HOLD_MS);
    expect(dyingHoldMsFor(false, 'fighter', true)).toBe(DESTRUCTION_PROFILES.subcap.fx.dyingHoldMs);
    expect(dyingHoldMsFor(true, 'cargo-pod', true), 'no wreck profile').toBe(0);
  });
});
