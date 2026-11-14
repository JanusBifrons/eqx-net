/**
 * Client side of "turrets face their shots" (owner 2026-11-14, fight clips
 * npc-dogfight / fleet-melee): an AI pilot's turret is drawn at the angle the
 * server sends in `SnapshotMessage.drones[].mountAngles`, the same angle its
 * shot leaves along (server: tests/unit/aiTurretFacesShot.test.ts and the
 * room-level tests/integration/sectorRoom/aiTurretFacesShot.test.ts).
 *
 * Feeds a real client snapshots of an interceptor whose wings train onto a
 * target and runs the per-frame display follower the renderer draws from
 * (`displayMountAngles`, which swarmSpriteUpdater hands to
 * MountVisualManager.applyMountAngles and the remote beam path reads).
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from '../../src/client/net/ColyseusClient';
import { slewDisplayMountAngles } from '../../src/client/net/displayMountAngles';
import type { SnapshotMessage } from '../../src/shared-types/messages';
import type { SwarmRenderState } from '../../src/core/contracts/IRenderer';
import { getShipKind } from '../../src/shared-types/shipKinds';

const EID = 11;
const MOUNTS = getShipKind('interceptor').mounts;

function snap(tick: number, a: number): SnapshotMessage {
  return {
    type: 'snapshot', serverTick: tick, ackedTick: tick, states: {},
    drones: [{ id: EID, mountAngles: MOUNTS.map(() => a) }],
  } as unknown as SnapshotMessage;
}

describe('an AI pilot\'s turret is drawn at the snapshot angle', () => {
  it('the drawn wing angles follow the server angles as they train', () => {
    const client = new ColyseusGameClient();
    (client.mirror as { localPlayerId: string | null }).localPlayerId = 'local';
    const entry = {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
      prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: 10, kind: 1, shipKind: 'interceptor',
    } as unknown as SwarmRenderState;
    client.mirror.swarm!.set(EID, entry);
    const handle = (s: SnapshotMessage): void => (client as unknown as { handleSnapshot: (m: SnapshotMessage) => void }).handleSnapshot(s);

    // The server trains the wings 0 → 0.45 rad at 4 rad/s: one 20 Hz snapshot
    // every three 60 Hz frames, then holds.
    let a = 0;
    for (let k = 0; k < 12; k++) {
      a = Math.min(0.45, a + 4 * 0.05);
      handle(snap(100 + k * 3, a));
      for (let f = 0; f < 3; f++) slewDisplayMountAngles(entry, MOUNTS, 1 / 60);
    }
    expect(entry.mountAngles, 'the snapshot turret slice was not applied').toBeDefined();
    for (let i = 0; i < MOUNTS.length; i++) {
      expect(entry.mountAngles![i]!).toBeCloseTo(0.45, 4);
      expect(Math.abs(entry.displayMountAngles![i]! - 0.45), `${MOUNTS[i]!.id} drawn off the server angle`).toBeLessThan(0.01);
    }
  });
});
