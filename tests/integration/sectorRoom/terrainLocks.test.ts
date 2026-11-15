/**
 * Neutral terrain locks through the REAL room (plan partitioned-chasing-lark
 * PR 2). Mining lasers and tractors lock what they work on, and no weapon
 * fires without a completed lock (#19), so a pilot may lock an asteroid
 * (kind 0) and a wreck piece (kind 4) — scrap / loot pods (kind 3) share the
 * same predicate, `isTerrainLockKind`. Locking terrain is NEUTRAL: no
 * failsafe ring, no `lock_hostile_act`, no `bot_aggro`, and the NPC beside it
 * does not turn hostile.
 *
 * Uses the real lock path (`lock_request` with `instantLock`), never
 * `forceLock`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipShapeToPolygon } from '../../../src/core/geometry/shipHullDecomp.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }
const WRECK_KIND = 4;

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — neutral terrain locks', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a pilot locks an asteroid and a wreck piece with no hostile act, no aggro and no hostility', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], subcapWrecks: true,
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    client.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) groups = st.groups;
    });
    let aggro = 0;
    client.onMessage('bot_aggro', () => { aggro++; });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;

    // A wreck piece: a fighter killed by a non-pilot hit leaves 2-3 pieces.
    expect(int().spawnTestDrone('victim', 0, 1500, 'fighter')).toBe(true);
    await harness.advance(100);
    const at = int().wreckState('victim')!;
    const v = shipShapeToPolygon(getShipKind('fighter'))[0]!;
    const c = Math.cos(at.angle), s = Math.sin(at.angle);
    int().applyDamage('victim', 'shooter-x', 1e7, at.x + v.x * c - v.y * s, at.y + v.x * s + v.y * c);
    const piece = [...int().swarmRegistry.all()].find((r) => r.kind === WRECK_KIND);
    expect(piece, 'the fighter left a wreck piece').toBeDefined();

    // An asteroid ahead, with a (peaceful) NPC bystander beside it.
    expect(int().spawnTestAsteroid('rock-1', 0, 400, 30)).toBe(true);
    expect(int().spawnTestDrone('bystander', 200, 400, 'fighter')).toBe(true);
    const rock = int().swarmRegistry.get('rock-1')!;
    expect(rock.kind).toBe(0);

    harness.events.clear();

    for (const key of [`s:${rock.entityId}`, `s:${piece!.entityId}`]) {
      client.send('lock_request', { type: 'lock_request', groupId: 'primary', target: key });
      harness.sendThrust(client);
      await waitUntil(() => groups?.[0]?.l.some((l) => l.t === key && l.s === 2) === true, 5_000, `${key} locked`);
      client.send('lock_cancel', { type: 'lock_cancel', groupId: 'primary', target: key });
    }
    await harness.advance(300);

    expect(harness.events.count({ tag: 'lock_hostile_act' }), 'locking terrain is no hostile act').toBe(0);
    expect(aggro, 'no bot_aggro').toBe(0);
    expect(int().npcHostileTo('bystander', pid), 'the NPC beside the rock stays neutral').toBe(false);
  }, 30_000);
});
