/**
 * Blocked-line hold, both sides of the wire (#15, #19; fire-control.md "Blocked
 * line hold"). The server holds a beam or railgun mount once its line to the
 * target has been blocked for the tolerance (`BlockedLineHold` on the one
 * line-of-fire grid); the client mirrors it so it draws no predicted beam the
 * server will refuse (`BlockedLineMirror` on its own first-hit ray,
 * `DisplayPoseHitscan`). Both step the one core timer (`BlockedLineTimers`).
 *
 * The same scenes (a clear line, a rock, another ship, a loot pod, a wreck
 * piece in the way) go through each side's REAL query for beams, the railgun
 * slug, a bolt and a shell, over a timeline across the tolerance: every
 * decision must agree. A blocker rule changed on one side only (say the client
 * stopping the slug on wreck) fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import type { SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { BLOCKED_LINE_HOLD_MS } from '../../src/core/combat/blockedLineHold.js';
import type { WeaponId } from '../../src/core/combat/WeaponCatalogue.js';
import { rayHitsSphere } from '../../src/core/combat/Weapons.js';
import { DisplayPoseHitscan } from '../../src/client/combat/displayPoseHitscan.js';
import { BlockedLineMirror } from '../../src/client/combat/blockedLineMirror.js';
import type { WreckGeometrySource } from '../../src/client/net/entity/IClientEntityLeaf.js';
import { LineOfFireGate, type LineOfFireBody } from '../../src/server/rooms/LineOfFireGate.js';
import { BlockedLineHold } from '../../src/server/rooms/BlockedLineHold.js';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../src/shared-types/sabLayout.js';

beforeAll(async () => { await RAPIER.init(); });

type Blocker = 'none' | 'rock' | 'ship' | 'pod' | 'wreck';
const BLOCKERS: Blocker[] = ['none', 'rock', 'ship', 'pod', 'wreck'];
const WEAPONS: WeaponId[] = ['hitscan', 'heavy_beam', 'railgun', 'laser', 'naval_l'];
/** Shooter at the origin, target 1000 u up, a blocker of radius 60 half way. */
const TARGET_Y = 1000;
const MID = 500;
const R = 60;
/** A wreck piece: one convex square part inside its radius (CCW). */
const WRECK_SQUARE = [{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }];
const TIMES = Array.from({ length: 13 }, (_, i) => i * (BLOCKED_LINE_HOLD_MS / 5));

interface Body extends LineOfFireBody { kind: number; shipKind?: string }

/** The server's decisions: the real `LineOfFireGate` over swarm-like bodies. */
function serverRun(blocker: Blocker, weaponId: WeaponId): boolean[] {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const recs: Body[] = [];
  const add = (id: string, x: number, y: number, radius: number, kind: number, shipKind?: string): void => {
    const b = slotBase(recs.length);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y;
    recs.push({ id, slot: recs.length, radius, kind, shipKind });
  };
  add('shooter', 0, 0, 20, 1, 'fighter');
  add('target', 0, TARGET_Y, 20, 1, 'fighter');
  if (blocker === 'rock') add('rock', 0, MID, R, 0);
  if (blocker === 'ship') add('other', 0, MID, R, 1, 'fighter');
  if (blocker === 'pod') add('pod', 0, MID, R, 3, 'cargo-pod');
  if (blocker === 'wreck') add('wreck', 0, MID, R, 4);
  let tick = 0;
  const gate = new LineOfFireGate<Body>({
    registry: { all: () => recs, version: 1 },
    sabF32: sab,
    tick: () => tick,
    rayHit: (rec, fx, fy, dx, dy, max, cx, cy) => rayHitsSphere(fx, fy, dx, dy, max, cx, cy, rec.radius),
  });
  const hold = new BlockedLineHold();
  return TIMES.map((t) => { tick++; return hold.held(gate, 'shooter', 0, weaponId, 0, 0, 0, TARGET_Y, 'shooter', 'target', t); });
}

function drawn(kind: number, y: number, radius: number, extra: Partial<SwarmRenderState> = {}): SwarmRenderState {
  return { x: 0, y, vx: 0, vy: 0, angle: 0, angvel: 0, radius, kind, shieldDown: false, ...extra } as unknown as SwarmRenderState;
}

/** The client's decisions: the real `DisplayPoseHitscan` over its predWorld + drawn swarm. */
async function clientRun(blocker: Blocker, weaponId: WeaponId): Promise<boolean[]> {
  const w = await PhysicsWorld.create();
  w.spawnShip('me', 0, 0);
  const swarm = new Map<number, SwarmRenderState>([[1, drawn(1, TARGET_Y, 20, { shipKind: 'fighter' })]]);
  const moving = new Set(['swarm-1']);
  const keys = new Map<number, string>([[1, 'swarm-1']]);
  if (blocker === 'rock') { w.spawnObstacle('swarm-9', 0, MID, R, 3); keys.set(9, 'swarm-9'); }
  const addMoving = (id: number, e: SwarmRenderState): void => { swarm.set(id, e); keys.set(id, `swarm-${id}`); moving.add(`swarm-${id}`); };
  if (blocker === 'ship') addMoving(2, drawn(1, MID, R, { shipKind: 'fighter' }));
  if (blocker === 'pod') addMoving(3, drawn(3, MID, R, { shipKind: 'cargo-pod' }));
  if (blocker === 'wreck') addMoving(4, drawn(4, MID, R, { wreckId: 7, componentIndex: 0 }));
  w.tick(1 / 60);
  const ray = new DisplayPoseHitscan(moving, keys);
  ray.world = w;
  ray.swarm = swarm;
  ray.wrecks = { has: () => true, piece: () => ({ index: 0, cx: 0, cy: 0, parts: [WRECK_SQUARE], radius: R }) } as unknown as WreckGeometrySource;
  const mirror = new BlockedLineMirror();
  const out = TIMES.map((t) => mirror.held(ray, 'me', 0, weaponId, 0, 0, 0, TARGET_Y, 'me', 'swarm-1', t));
  w.dispose();
  return out;
}

describe('blocked-line hold: client mirror agrees with the server (#15)', () => {
  for (const blocker of BLOCKERS) {
    for (const weaponId of WEAPONS) {
      it(`${weaponId} behind ${blocker}`, async () => {
        const server = serverRun(blocker, weaponId);
        const client = await clientRun(blocker, weaponId);
        expect(client, `client vs server, ${weaponId} behind ${blocker}`).toEqual(server);
      });
    }
  }

  it('the scenes cover both outcomes: a beam behind a rock holds, the slug passes a wreck, nothing holds on a pod', async () => {
    const last = (a: boolean[]): boolean => a[a.length - 1]!;
    expect(last(serverRun('rock', 'hitscan'))).toBe(true);
    expect(last(await clientRun('rock', 'hitscan'))).toBe(true);
    expect(last(await clientRun('wreck', 'heavy_beam'))).toBe(true);
    expect(last(await clientRun('wreck', 'railgun'))).toBe(false);
    expect(last(await clientRun('rock', 'railgun'))).toBe(true);
    expect(last(await clientRun('pod', 'hitscan'))).toBe(false);
    expect(last(await clientRun('rock', 'laser')), 'a bolt is never held').toBe(false);
    expect((await clientRun('rock', 'hitscan'))[0], 'not before the tolerance').toBe(false);
  });
});
