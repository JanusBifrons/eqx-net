/**
 * Owner decision 2026-11-14: when guns choose their own target, HEAVY guns
 * (M/L/XL) prefer what they can hurt (capitals and structures in fire range)
 * and fall back to fighters only when nothing big is in reach; light guns and
 * AA keep preferring small fast targets. One rule (`mountPriority`) for
 * players and AI.
 *
 * Here the player side, through a real SectorRoom: a pilot battleship whose
 * groups are all AUTO, a hostile fighter close on the starboard beam and a
 * hostile heavy cruiser further out ahead. Before the fix the player AUTO
 * pick (`SectorRoom` `autoPick`) was nearest-first with no gun size, so the
 * main battery locked the fighter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — heavy guns prefer big targets (player AUTO)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function run(dronePoses: Array<{ kind: string; x: number; y: number; angle: number }>): Promise<{
    groups: () => SnapGroups[] | undefined; idOf: (kind: string) => string;
  }> {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true, dronePoses,
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'battleship', spawnX: 0, spawnY: 0, startHostile: true, initialHull: 10_000_000, initialShield: 0,
    });
    let groups: SnapGroups[] | undefined;
    cr.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid) groups = st.groups;
    });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const idOf = (kind: string): string => {
      const rec = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === kind);
      return `s:${rec!.entityId}`;
    };
    return { groups: () => groups, idOf };
  }

  const first = (gs: SnapGroups[] | undefined, id: string): string | undefined => gs?.find((g) => g.id === id)?.l[0]?.t;

  it('the main battery AUTO-picks the capital, the AA the fighter', { timeout: 30_000 }, async () => {
    // Fighter ~1,100 u off the starboard beam (inside 40 mm AA reach), the
    // cruiser ~6 km ahead (its hull inside 16" reach, at legacy and real).
    const h = await run([
      { kind: 'fighter', x: 1100, y: 900, angle: 0 },
      { kind: 'heavy-cruiser', x: 0, y: 6500, angle: 0 },
    ]);
    await waitUntil(() => first(h.groups(), 'main') !== undefined && first(h.groups(), 'aa') !== undefined, 10_000, 'main + aa auto-locks');
    expect(first(h.groups(), 'main'), 'the 16" guns take the capital').toBe(h.idOf('heavy-cruiser'));
    expect(first(h.groups(), 'aa'), 'the AA takes the fighter').toBe(h.idOf('fighter'));
  });

  it('fallback: with only a fighter in reach, the main battery still picks it', { timeout: 30_000 }, async () => {
    const h = await run([{ kind: 'fighter', x: 1100, y: 900, angle: 0 }]);
    await waitUntil(() => first(h.groups(), 'main') !== undefined, 10_000, 'main auto-lock');
    expect(first(h.groups(), 'main')).toBe(h.idOf('fighter'));
  });
});
