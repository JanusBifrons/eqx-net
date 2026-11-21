/**
 * Live bug 2026-11-21: after placing the starter Capital in Build mode the
 * HUD kept reading one packed crate ("▢1") for 10+ minutes. Build / Command
 * parks the hull, so `handleSnapshot` takes the no-own-ship branch and the
 * own cargo slice (now sent on the parked hull's entry too) was never applied:
 * the store froze at its last piloted value (#16).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import { useUIStore } from '../state/store.js';

type Internals = { handleSnapshot: (snap: SnapshotMessage) => void };
const internals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function parkedSnapshot(tick: number, packed: number): SnapshotMessage {
  const cargo = { goods: { salvage: 3 }, blueprints: [{}, {}], packed: Array.from({ length: packed }, () => ({ product: 'structure:capital', quality: 50 })) };
  return {
    type: 'snapshot', serverTick: tick, ackedTick: tick,
    states: { 'parked-hull': { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'local-player', isActive: false, cargo } },
  } as unknown as SnapshotMessage;
}

describe('own cargo readout while the hull is parked by Build / Command', () => {
  let client: ColyseusGameClient;
  beforeEach(() => {
    client = new ColyseusGameClient();
    const m = client.mirror as { localPlayerId: string | null; localShipInstanceId?: string | null };
    m.localPlayerId = 'local-player';
    m.localShipInstanceId = 'parked-hull';
    useUIStore.getState().setPilotMode('spectator');
    useUIStore.getState().setCargo({ goods: {}, blueprints: 2, packed: 1, packedWeight: 25 }, 40);
  });

  it('the crate leaves the readout once the parked hull no longer carries it', () => {
    internals(client).handleSnapshot(parkedSnapshot(100, 0));
    const cargo = useUIStore.getState().cargo;
    expect(cargo?.packed ?? 0, `store cargo: ${JSON.stringify(cargo)}`).toBe(0);
    expect(cargo?.goods['salvage']).toBe(3);
  });
});
