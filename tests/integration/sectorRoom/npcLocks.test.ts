/**
 * Fire control — locking goes both ways. A hostile NPC must LOCK a pilot
 * before it may fire at them; the pilot sees the lock building in the
 * own-ship `lockedBy` snapshot slice (acquiring → locked). Every pilot is
 * tracked (lock-to-fire is universal): this one joins with no options.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { LOCKED_BY_WIRE_ROWS } from '../../../src/shared-types/combat/lockProfile.js';

interface LockedBy { t: string; s: number; p: number }
interface DamageMsg { targetId?: string }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — NPCs lock pilots', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true,
      dronePoses: [{ kind: 'fighter', x: 0, y: 160, angle: Math.PI }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a hostile drone locks the pilot (acquiring → locked) before it lands a hit', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, startHostile: true, initialHull: 100_000,
    })) as ClientRoom<SectorState>;
    let lockedBy: LockedBy[] | undefined;
    let sawAcquiring = false;
    let lockedAt = 0;
    let firstHitAt = 0;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; lockedBy?: LockedBy[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) {
        if (st.playerId !== pid) continue;
        lockedBy = st.lockedBy;
        if (lockedBy?.some((l) => l.s === 1)) sawAcquiring = true;
        if (!lockedAt && lockedBy?.some((l) => l.s === 2)) lockedAt = Date.now();
      }
    });
    room.onMessage('damage', (m: DamageMsg) => {
      if (m.targetId === pid && !firstHitAt) firstHitAt = Date.now();
    });
    await waitUntil(() => lockedAt > 0, 12_000, 'drone locked the pilot');
    expect(sawAcquiring).toBe(true);
    expect(lockedBy![0]!.t).toMatch(/^s:\d+$/);
    // Any hit before the lock completed would mean an unlocked shot.
    if (firstHitAt) expect(firstHitAt).toBeGreaterThanOrEqual(lockedAt - 120);
    await waitUntil(() => firstHitAt > 0, 8_000, 'drone fires once locked');
  }, 30_000);
});

// Owner 2026-11-14: the own-ship slice carries only the nearest lockers
// (completed first) plus `lockedByN`, the total, so its cost stays flat
// however many hostiles lock on.
describe('SectorRoom integration — lockedBy rows are capped, the total rides lockedByN', () => {
  let harness: SectorTestHarness;
  // 20 hostile fighters on a ring of growing radius around the pilot.
  const POSES = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2;
    const r = 400 + i * 60;
    return { kind: 'fighter', x: Math.cos(a) * r, y: Math.sin(a) * r, angle: a + Math.PI };
  });
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, dronePoses: POSES });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it(`20 hostile lockers ⇒ exactly ${LOCKED_BY_WIRE_ROWS} rows and lockedByN = 20`, async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, startHostile: true, initialHull: 1_000_000,
    })) as ClientRoom<SectorState>;
    let rows: LockedBy[] | undefined;
    let total: number | undefined;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; lockedBy?: LockedBy[]; lockedByN?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) {
        if (st.playerId !== pid) continue;
        rows = st.lockedBy;
        total = st.lockedByN;
      }
    });
    await waitUntil(() => total === 20, 12_000, 'all 20 drones lock on');
    expect(rows).toHaveLength(LOCKED_BY_WIRE_ROWS);
    for (const r of rows!) expect(r.t).toMatch(/^s:\d+$/);
  }, 30_000);
});
