/**
 * Fire control — the held lock line (#15). The client's pick under the line
 * (`updateLockGuide`) must use the SAME rule the server uses to verify a
 * `lock_track` claim (`core/combat/lockLine.ts`), and a held target's claim must
 * carry `b`, the line's quantised bearing (the server ignores a non-null target
 * without it). Also locks the alloc-free candidate keys (#14): the key string
 * for an id is built once and reused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store';
import { lockLineHolds, lockLineScore } from '@core/combat/lockLine';
import { decodeAim, encodeAim } from '@core/combat/manualAim';
import { getShipKind } from '@shared-types/shipKinds';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  room: { send: (type: string, msg: unknown) => void } | null;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    swarm: Map<number, SwarmRenderState>;
    structures: Map<number, { owner?: string }>;
    localPlayerId: string | null;
    localLockCandidate?: string | null;
  };
}

const ME = 'me';

function drone(x: number, y: number, kind = 1): SwarmRenderState {
  return { kind, x, y, vx: 0, vy: 0, angle: 0, radius: 12 } as unknown as SwarmRenderState;
}

describe('lock line pick (updateLockGuide)', () => {
  let client: ColyseusGameClient;
  let m: Internals['mirror'];
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ColyseusGameClient();
    const internals = client as unknown as Internals;
    send = vi.fn();
    internals.room = { send };
    m = internals.mirror;
    m.localPlayerId = ME;
    m.ships.set(ME, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' });
    m.swarm = new Map();
    m.structures = new Map();
    useUIStore.setState({ activeGroupId: getShipKind('fighter').slots![0]!.id });
  });

  it('picks the lowest shared lockLineScore (the server rule), skipping own structures', () => {
    m.swarm.set(1, drone(40, 300)); // near the line, ahead
    m.swarm.set(2, drone(-5, 150)); // nearer + better centred
    m.swarm.set(3, drone(0, -200)); // behind: never
    m.swarm.set(4, drone(0, 100, 2)); // own structure: never
    m.structures.set(4, { owner: ME });
    const bearing = 0; // line along +y
    const reach = (client as unknown as { _fcInfo: Map<string, { reach: number }> })._fcInfo;
    const got = client.updateLockGuide(bearing);
    const r = reach.get(useUIStore.getState().activeGroupId!)!.reach;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [id, e] of m.swarm) {
      if (id === 4) continue;
      const s = lockLineScore(e.x, e.y, -Math.sin(bearing), Math.cos(bearing), e.radius ?? 20, r, false);
      if (s < bestScore) { bestScore = s; best = `s:${id}`; }
    }
    expect(got).toBe(best);
    expect(got).toBe('s:2');
  });

  it('reuses the candidate key string per id (no new string per pick, #14)', () => {
    m.swarm.set(7, drone(0, 200));
    const a = client.updateLockGuide(0);
    const b = client.updateLockGuide(0);
    expect(a).toBe('s:7');
    expect(Object.is(a, b)).toBe(true);
  });

  it('a held target claim carries b; the server check accepts it on that line', () => {
    m.swarm.set(9, drone(10, 250));
    const bearing = 0.03;
    client.guideLock(bearing);
    const [type, msg] = send.mock.calls.at(-1)! as [string, { target: string | null; b?: number; groupId: string }];
    expect(type).toBe('lock_track');
    expect(msg.target).toBe('s:9');
    expect(msg.b).toBe(encodeAim(bearing));
    // Server side of the contract: the decoded bearing still holds the target.
    expect(lockLineHolds(10, 250, decodeAim(msg.b!), 12, 600)).toBe(true);
    // Unchanged key → no resend; letting go sends target null without b.
    client.guideLock(bearing);
    expect(send.mock.calls.length).toBe(1);
    client.releaseLockGuide();
    const [, rel] = send.mock.calls.at(-1)! as [string, { target: string | null; b?: number }];
    expect(rel.target).toBeNull();
    expect(rel.b).toBeUndefined();
  });
});
