/**
 * Hostile review of the capital-turrets clip (2026-11-12, showcase
 * `showcase-capital-duel`, 13.0-14.5 s): an NPC battleship's 16" shells left
 * from points and in directions ~45-60 degrees away from its DRAWN barrels.
 * The forward turrets were drawn pointing toward the bow while their shells
 * flew aft of the beam; the aft turret was drawn pointing toward the stern
 * while its shells left ahead of it.
 *
 * Measured (2026-11-12):
 *  - server: every shell leaves the server's own barrel tip along the server
 *    barrel angle (tip error 0.0 u, heading error 0.0 deg), and the snapshot's
 *    `drones[].mountAngles` equal the server angles to 0.3 deg, before and
 *    after the pilot spectates;
 *  - browser (Playwright, the duel room): after Spectate, the battleship's
 *    `mirror.swarm[..].mountAngles` froze at [-56, -79, 81] deg for 40 s while
 *    the server trained on to -112 deg and fired; the hull pose (binary wire)
 *    kept updating.
 *
 * Cause: `handleSnapshot` applied the drone slice (`applyDroneMountAngles`)
 * only for a pilot with an own-ship state, after the reconciler gate. A
 * spectator has no own ship, so every NPC turret froze where it was when the
 * pilot spectated, while naval shells (events, not the snapshot) kept leaving
 * the real barrels.
 *
 * This test feeds the client real snapshots as a spectator (and before the
 * reconciler exists), then a salvo built with the server's muzzle rules, and
 * compares the barrel the renderer would draw with the shells.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipShotMuzzle, navalTurret, navalBarrelOffset } from '../../core/combat/muzzle.js';
import { shipTurrets, muzzleReach } from '../render/art/turretLayout.js';

type Internals = {
  handleSnapshot: (snap: SnapshotMessage) => void;
  _shellStore: ShellSalvoStore;
  reconciler: unknown;
};
const internals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

const BS_EID = 7;
const DEG = Math.PI / 180;
const KIND = getShipKind('battleship');
const MOUNTS = KIND.mounts!;

function battleshipEntry(): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0, radius: KIND.radius, kind: 1, shipKind: 'battleship',
  } as unknown as SwarmRenderState;
}

/** A snapshot for a pilot who is spectating: their hull is parked
 *  (isActive false), so there is no own active ship state. */
function spectatorSnapshot(tick: number, mainAngles: [number, number, number]): SnapshotMessage {
  const angles = MOUNTS.map((_, i) => (i < 3 ? mainAngles[i]! : 0));
  return {
    type: 'snapshot',
    serverTick: tick,
    ackedTick: tick,
    states: {
      'parked-hull': { x: 4000, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'local-player', isActive: false },
    },
    drones: [{ id: BS_EID, mountAngles: angles, hostile: true }],
  } as SnapshotMessage;
}

/** The salvo the server fires from mount `i` at arc-local `cur` (the
 *  AiFireResolver rules: hull + base + mount angle, the shared muzzle and
 *  barrel offsets), the hull at the origin, nose +y. */
function serverSalvo(i: number, cur: number): ShellSalvo {
  const m = MOUNTS[i]!;
  const a = m.baseAngle + cur;
  const dx = -Math.sin(a), dy = Math.cos(a);
  const md = shipShotMuzzle(KIND, m, true);
  const fx = m.localX + dx * md, fy = m.localY + dy * md;
  const nt = navalTurret(KIND, m)!;
  const sh: ShellSalvo['sh'] = [];
  for (let k = 0; k < nt.barrels; k++) {
    const off = navalBarrelOffset(nt, k);
    sh.push([`s${i}-${k}`, fx + dy * off, fy - dx * off, dx * 900, dy * 900]);
  }
  return { type: 'shell_salvo', s: i, o: `swarm-${BS_EID}`, w: 'naval_xl', t: 100, n: 600, sh };
}

/** Where the renderer draws mount `i`'s muzzle (the art layout's pivot and
 *  reach, Pixi y-down, turned by -(base + angle)) and the barrel heading, in
 *  game space (hull at the origin, nose +y). */
function drawnBarrel(i: number, cur: number): { x: number; y: number; heading: number } {
  const place = shipTurrets('battleship').find((p) => p.mount.id === MOUNTS[i]!.id)!;
  const r = -(MOUNTS[i]!.baseAngle + cur);
  const reach = muzzleReach(place);
  const px = place.px + Math.sin(r) * reach, py = place.py - Math.cos(r) * reach;
  return { x: px, y: -py, heading: -r };
}

function angleErrDeg(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) / DEG;
}

describe('a spectator sees NPC turrets aim where their shells go', () => {
  let client: ColyseusGameClient;
  beforeEach(() => {
    client = new ColyseusGameClient();
    (client.mirror as { localPlayerId: string | null }).localPlayerId = 'local-player';
    client.mirror.swarm!.set(BS_EID, battleshipEntry());
  });

  const TRAINING: [number, number, number] = [-57 * DEG, -79 * DEG, 81 * DEG];
  const ON_TARGET: [number, number, number] = [-110 * DEG, -104 * DEG, 113 * DEG];

  for (const withReconciler of [false, true]) {
    it(`snapshot turret angles keep applying while spectating (${withReconciler ? 'after' : 'before'} the reconciler exists)`, () => {
      // A pilot who flew before spectating still holds a reconciler.
      if (withReconciler) internals(client).reconciler = {};
      internals(client).handleSnapshot(spectatorSnapshot(100, TRAINING));
      internals(client).handleSnapshot(spectatorSnapshot(101, ON_TARGET));
      const got = client.mirror.swarm!.get(BS_EID)!.mountAngles;
      expect(got, 'the drone turret slice was never applied').toBeDefined();
      for (let i = 0; i < 3; i++) expect(got![i]!).toBeCloseTo(ON_TARGET[i]!, 6);
    });
  }

  it('each shell leaves the drawn barrel tip along the drawn barrel', () => {
    internals(client).handleSnapshot(spectatorSnapshot(100, TRAINING));
    internals(client).handleSnapshot(spectatorSnapshot(101, ON_TARGET));
    const drawnAngles = client.mirror.swarm!.get(BS_EID)!.mountAngles ?? [];
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      internals(client)._shellStore.applySalvo(serverSalvo(i, ON_TARGET[i]!));
      const drawn = drawnBarrel(i, drawnAngles[i] ?? 0);
      let cx = 0, cy = 0, vx = 0, vy = 0;
      const nt = navalTurret(KIND, MOUNTS[i])!;
      for (let k = 0; k < nt.barrels; k++) {
        const r = internals(client)._shellStore.map.get(`s${i}-${k}`)!;
        cx += r.x0 / nt.barrels; cy += r.y0 / nt.barrels; vx = r.vx; vy = r.vy;
      }
      const tipErr = Math.hypot(cx - drawn.x, cy - drawn.y);
      const headErr = angleErrDeg(Math.atan2(-vx, vy), drawn.heading);
      if (tipErr > 1 || headErr > 0.5) lines.push(`${MOUNTS[i]!.id}: shell origin ${tipErr.toFixed(0)} u from the drawn tip, heading off by ${headErr.toFixed(1)} deg`);
    }
    expect(lines).toEqual([]);
  });
});
