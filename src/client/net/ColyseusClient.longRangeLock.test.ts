/**
 * Real-scale naval ranges (`navalRange=real`): the client's lock-line pick
 * (`updateLockGuide`) has no distance or interest cut-off of its own, only the
 * active group's reach × `LOCK_LINE.reachSlack` (the shared rule the server
 * verifies `lock_track` with, #15). A battleship pilot pointing the main
 * battery's line at a target 30 km out picks it, whatever its kind: an NPC
 * capital, an NPC fighter, a structure or another pilot. Past reach × 1.1 the
 * line holds nothing.
 *
 * The catalogue is built at module load, so the modules are re-imported with
 * the switch on (the same pattern as tests/unit/navalRangeSwitch.test.ts).
 * Server side: tests/integration/navalReal/longRangeLock.test.ts.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  room: { send: (type: string, msg: unknown) => void } | null;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    swarm: Map<number, SwarmRenderState>;
    structures: Map<number, { owner?: string }>;
    localPlayerId: string | null;
  };
  _fcInfo: Map<string, { reach: number }>;
}

const ME = 'me';
const RANGE = 30_000;

async function realModeClient() {
  vi.stubEnv('EQX_NAVAL_RANGE', 'real');
  vi.resetModules();
  const { ColyseusGameClient } = await import('./ColyseusClient.js');
  const { useUIStore } = await import('../state/store');
  const { lockLineHolds } = await import('@core/combat/lockLine');
  const { decodeAim } = await import('@core/combat/manualAim');
  const { getShipKind } = await import('@shared-types/shipKinds');
  const { NAVAL_RANGE } = await import('@shared-types/combat/navalRange');
  const client = new ColyseusGameClient();
  const internals = client as unknown as Internals;
  const send = vi.fn();
  internals.room = { send };
  const m = internals.mirror;
  m.localPlayerId = ME;
  m.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'battleship' });
  m.swarm = new Map();
  m.structures = new Map();
  useUIStore.setState({ activeGroupId: 'main' });
  return { client, internals, m, send, lockLineHolds, decodeAim, getShipKind, NAVAL_RANGE };
}

const swarm = (kind: number, x: number, y: number, radius: number): SwarmRenderState =>
  ({ kind, x, y, vx: 0, vy: 0, angle: 0, radius }) as unknown as SwarmRenderState;

describe('real naval ranges — the lock-line pick reaches 30 km', () => {
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('a battleship main battery picks an NPC capital, fighter, structure or pilot 30 km out', async () => {
    const { client, internals, m, send, lockLineHolds, decodeAim, getShipKind, NAVAL_RANGE } = await realModeClient();
    expect(NAVAL_RANGE).toBe('real');
    // The pick reads the group's reach from the catalogue: the 16" reaches 38.7 km.
    client.updateLockGuide(0);
    const reach = internals._fcInfo.get('main')!.reach;
    expect(reach).toBeGreaterThan(38_000);

    // One target at a time, each 30 km out on its own bearing.
    const cases: Array<[string, () => void, number, number]> = [
      ['s:1', () => m.swarm.set(1, swarm(1, 0, RANGE, getShipKind('battleship').radius)), 0, RANGE],
      ['s:2', () => m.swarm.set(2, swarm(1, 4_000, RANGE, getShipKind('fighter').radius)), 4_000, RANGE],
      ['s:3', () => m.swarm.set(3, swarm(2, -4_000, RANGE, 195)), -4_000, RANGE],
      ['p:other', () => m.ships.set('other', { x: 8_000, y: RANGE, vx: 0, vy: 0, angle: 0, kind: 'battleship' }), 8_000, RANGE],
    ];
    for (const [key, add, x, y] of cases) {
      m.swarm.clear();
      m.ships.delete('other');
      client.releaseLockGuide();
      add();
      const bearing = Math.atan2(-x, y);
      client.guideLock(bearing);
      expect(m.swarm.size + m.ships.size, 'one target').toBe(2);
      const [type, msg] = send.mock.calls.at(-1)! as [string, { target: string | null; b?: number }];
      expect(type).toBe('lock_track');
      expect(msg.target, `${key} 30 km out is picked`).toBe(key);
      // And the server's check holds it on the quantised line.
      expect(lockLineHolds(x, y, decodeAim(msg.b!), 50, reach), `${key}: the server accepts the claim`).toBe(true);
    }

    // Past reach × 1.1 (42.6 km) the line holds nothing.
    m.swarm.clear();
    m.ships.delete('other');
    client.releaseLockGuide();
    m.swarm.set(5, swarm(1, 0, 45_000, getShipKind('battleship').radius));
    expect(client.updateLockGuide(0), 'a capital 45 km out: past reach').toBeNull();
  });
});
