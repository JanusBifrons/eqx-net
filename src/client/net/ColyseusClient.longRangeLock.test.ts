/**
 * Real-scale naval ranges (`navalRange=real`): the client's lock-line pick
 * (`updateLockGuide`) has no distance or interest cut-off of its own; the
 * line ends at lock range (`LOCK_TUNING.maxLockRange`, 1 km hull to hull,
 * owner 2026-11-21), whatever the group's reach. The shared rule the server
 * verifies `lock_track` with is `lockLineScore` (#15), measured from the
 * pilot's own hull. A battleship pilot pointing the main battery's line at a
 * target 0.9 km off its hull picks it, whatever its kind: an NPC capital, an
 * NPC fighter, a structure or another pilot; 1.3 km off, nothing.
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
  fc: { _fcInfo: Map<string, { reach: number }> };
}

const ME = 'me';
/** Gap off the shooter's hull to the target's hull: inside lock range (1 km). */
const GAP = 900;

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

describe('real naval ranges — the lock-line pick ends at lock range, whatever the reach', () => {
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('a battleship main battery picks an NPC capital, fighter, structure or pilot 0.9 km off its hull, not 1.3 km', async () => {
    const { client, internals, m, send, lockLineHolds, decodeAim, getShipKind, NAVAL_RANGE } = await realModeClient();
    expect(NAVAL_RANGE).toBe('real');
    // The pick reads the group's reach from the catalogue: the 16" reaches 38.7 km.
    client.updateLockGuide(0);
    const reach = internals.fc._fcInfo.get('main')!.reach;
    expect(reach).toBeGreaterThan(38_000);
    const self = getShipKind('battleship').radius;
    const bsR = getShipKind('battleship').radius;
    const fR = getShipKind('fighter').radius;
    /** Centre of a target of radius `r`, `gap` u off our hull on bearing `b`. */
    const at = (b: number, r: number, gap: number): [number, number] => {
      const d = self + r + gap;
      return [-Math.sin(b) * d, Math.cos(b) * d];
    };

    // One target at a time, each on its own bearing.
    const cases: Array<[string, number, number, (x: number, y: number) => void]> = [
      ['s:1', 0, bsR, (x, y) => m.swarm.set(1, swarm(1, x, y, bsR))],
      ['s:2', -0.3, fR, (x, y) => m.swarm.set(2, swarm(1, x, y, fR))],
      ['s:3', 0.3, 195, (x, y) => m.swarm.set(3, swarm(2, x, y, 195))],
      ['p:other', -0.6, bsR, (x, y) => m.ships.set('other', { x, y, vx: 0, vy: 0, angle: 0, kind: 'battleship' })],
    ];
    for (const [key, b, r, add] of cases) {
      m.swarm.clear();
      m.ships.delete('other');
      client.releaseLockGuide();
      const [x, y] = at(b, r, GAP);
      add(x, y);
      client.guideLock(b);
      expect(m.swarm.size + m.ships.size, 'one target').toBe(2);
      const [type, msg] = send.mock.calls.at(-1)! as [string, { target: string | null; b?: number }];
      expect(type).toBe('lock_track');
      expect(msg.target, `${key} 0.9 km off the hull is picked`).toBe(key);
      // And the server's check holds it on the quantised line.
      expect(lockLineHolds(x, y, decodeAim(msg.b!), r, reach, self), `${key}: the server accepts the claim`).toBe(true);
    }

    // Past lock range (1.3 km off the hull, well inside the 16"'s reach) the
    // line holds nothing: owner 2026-11-21, locks only within ~1 km.
    m.swarm.clear();
    m.ships.delete('other');
    client.releaseLockGuide();
    const [fx, fy] = at(0, bsR, 1300);
    m.swarm.set(5, swarm(1, fx, fy, bsR));
    expect(client.updateLockGuide(0), 'a capital 1.3 km off the hull: not picked').toBeNull();
    expect(lockLineHolds(fx, fy, 0, bsR, reach, self), 'the server refuses it too').toBe(false);
  });
});
