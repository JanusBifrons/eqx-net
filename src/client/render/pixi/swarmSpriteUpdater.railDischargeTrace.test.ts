/**
 * The railgun's slot charge must not go dark before its shot shows: a replay
 * of a REAL in-game frame trace through the real pipeline (invariant #13: the
 * bug survived a telegraph-level fix, so this test sits a level up).
 *
 * Report (hostile review of the rail-channel take, 2026-11-15, built with the
 * discharge hold): the slot was full for 6 frames, then dark for 6 frames
 * (100 ms), then the muzzle flash. The telegraph-level tests passed because
 * they charged the gun with `nowTick = start + chargeTicks`, so the drawn level
 * was exactly 1 and the hold ("a charge that ended FULL holds until the shot")
 * started.
 *
 * In the game it is never exactly 1. Probe (battleship-rail vs a heavy-cruiser
 * pilot, `?worker=0`, per-frame telegraph log): the server fires on tick
 * start + 360, and the snapshot that clears the mask arrives on the frame
 * after the last mask-on frame, whose drawn level was 0.99991 (5999.5 ms of
 * 6000: the start latches against a frame clock a fraction of a frame behind
 * the tick). So `levels >= 1` failed, no hold began, and the slot went dark
 * 84 ms before the slug and its flash were drawn (the display delay).
 *
 * The frames below are that probe's rows: fx ms, the entity's latest tick,
 * and the snapshot mask (bit 2 = the third main turret). The mask goes in
 * through the real snapshot ingest (`applyDroneMountAngles`), the frames
 * through the real `updateSwarmSprites`. The slug showed at fx 34334.4.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { applyDroneMountAngles } from '../../net/snapshotRemoteSync.js';
import type { PoseRingEntry, RenderMirror, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../../shared-types/messages/snapshotMessages.js';

const ID = 7;
const START_TICK = 1573;
/** [fxNowMs, lastUpdateTick, chargingMask] per frame, from the probe. */
const CHARGE_FRAMES: ReadonlyArray<readonly [number, number, number]> = [
  [28250.2, 1574, 4], // the first snapshot with the charge: the start latches
  [34050.8, 1922, 4], [34066.8, 1923, 4], [34083, 1924, 4], [34100, 1925, 4],
  [34116.1, 1926, 4], [34132.9, 1927, 4], [34149.7, 1928, 4], [34166.5, 1930, 4],
  [34183.7, 1931, 4], [34199.7, 1932, 4], [34217, 1933, 4], [34233, 1933, 4],
];
/** The frames after the server fired (mask clear) until the slug is drawn. */
const DARK_FRAMES: ReadonlyArray<readonly [number, number]> = [
  [34250.3, 1934], [34266.8, 1935], [34284.2, 1936], [34300.4, 1937], [34316.2, 1938],
];

function ring(): PoseRingEntry[] {
  const r: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) r.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return r;
}

function railBattleship(): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: ring(), ringHead: 0,
    radius: 400, kind: 1, shipKind: 'battleship-rail', sleeping: true, lastUpdateTick: 0,
  };
}

function makeCtx(): SwarmSpriteCtx {
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
    art: { art: null, handles: new Map(), sunAz: 0 },
    slewDtSec: 1 / 60,
  };
}

/** Rail slot glows (a Container of fill + head) drawn this frame:
 *  visible all the way up to the ship sprite. */
function litRailSlots(sprite: Container): number {
  let n = 0;
  const walk = (c: Container, shown: boolean): void => {
    const on = shown && c.visible;
    if (!(c instanceof Graphics) && c.children.length === 2 && c.children.every((k) => k instanceof Graphics)) {
      if (on) n++;
      return;
    }
    for (const k of c.children) walk(k as Container, on);
  };
  walk(sprite, true);
  return n;
}

function snapshot(mask: number): SnapshotMessage {
  return { drones: mask !== 0 ? [{ id: ID, chargingMask: mask, chargeStartTick: START_TICK }] : [] } as unknown as SnapshotMessage;
}

describe('railgun slot charge, replayed from a real frame trace', () => {
  it('stays lit from the mask clearing until the slug is drawn', () => {
    const entry = railBattleship();
    const mirror = { swarm: new Map([[ID, entry]]) } as unknown as RenderMirror;
    const ctx = makeCtx();
    for (const [fx, tick, mask] of CHARGE_FRAMES) {
      applyDroneMountAngles(snapshot(mask), mirror);
      entry.lastUpdateTick = tick;
      ctx.fxNowMs = fx;
      updateSwarmSprites(mirror, ctx);
    }
    const sprite = ctx.sprites.get(`swarm-${ID}`)!;
    expect(litRailSlots(sprite), 'charging: the slot is lit').toBe(1);
    // The server fired: the next snapshot drops the bit. The slug is drawn a
    // display delay later (fx 34334.4); until then the charge must stay lit.
    applyDroneMountAngles(snapshot(0), mirror);
    for (const [fx, tick] of DARK_FRAMES) {
      entry.lastUpdateTick = tick;
      ctx.fxNowMs = fx;
      updateSwarmSprites(mirror, ctx);
      expect(litRailSlots(sprite), `slot dark at fx ${fx}, before the slug shows`).toBe(1);
    }
  });
});
