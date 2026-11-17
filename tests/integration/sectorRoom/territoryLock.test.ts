/**
 * Sector control — the Territory Lock structure through a real SectorRoom and
 * the real control meter (`RobotTerritory`):
 *  1. a player whose side doesn't hold the sector is refused, with a notice;
 *  2. the holder places one; a second is refused;
 *  3. it builds like any structure, draining TERRITORY_LOCK_COST minerals;
 *  4. once built, the sector holds against a big robot force; destroy the lock
 *     and the robots take it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { RobotTerritory } from '../../../src/server/livingworld/RobotTerritory.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import { TERRITORY_LOCK_COST } from '../../../src/shared-types/structureKinds.js';
import { CONSTRUCTION_PULSE_AMOUNT } from '../../../src/core/structures/structureGridConstants.js';
import { LOCK_NOT_HELD_REASON, LOCK_TAKEN_REASON } from '../../../src/server/structures/territoryLockRules.js';

const KEY = 'orion-belt';

describe('SectorRoom integration — Territory Lock (sector control)', () => {
  let harness: SectorTestHarness | undefined;
  let territory: RobotTerritory | undefined;
  afterEach(async () => {
    territory?.stop();
    territory = undefined;
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('only the holder may build one, once; it costs its minerals; it holds the sector until destroyed', async () => {
    harness = await bootSectorTestServer({ sectorKey: KEY, asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const notices: string[] = [];
    room.onMessage('notice', (m: { text: string }) => notices.push(m.text));
    const internals = harness.getServerRoom()!._internals;
    const reg = internals.structureRegistry;

    const robots = new Map<string, number>();
    const clock = { now: 0 };
    territory = new RobotTerritory(
      new Map([[KEY, harness.getServerRoom() as unknown as LivingWorldRoom]]),
      () => robots,
      { nowMs: () => clock.now, nexusSector: '__none__' },
    );
    territory.start();
    const run = (s: number): void => { for (let i = 0; i < s; i++) { clock.now += 1000; territory!.tick(clock.now); } };

    const placeOne = async (kind: string, x: number, y: number): Promise<void> => {
      room.send('place_structure', { type: 'place_structure', kind, x, y });
      await harness!.advance(200);
    };
    const noticeOf = async (text: string): Promise<void> => {
      for (let i = 0; i < 25 && !notices.includes(text); i++) await harness!.advance(80);
      expect(notices).toContain(text);
    };
    const locks = () => [...reg.all()].filter((s) => s.kind === 'territory_lock');

    await placeOne('capital', 0, 0);
    const cap = [...reg.all()].find((s) => s.kind === 'capital')!;
    // A Capital links only to a Connector: the lock hangs off this relay.
    await placeOne('connector', 400, 0);

    // 1. Neutral sector: refused, with the reason.
    expect(territory.controlState(KEY)!.holder).toBeNull();
    await placeOne('territory_lock', 700, 0);
    expect(locks()).toHaveLength(0);
    await noticeOf(LOCK_NOT_HELD_REASON);

    // 2. The player's side takes the sector (restored held: a capital alone is slow).
    const side = cap.owner; // the account-bound player id
    territory.restoreControl([{ sectorKey: KEY, holder: side, shares: [[side, 100]] }]);
    await placeOne('territory_lock', 700, 0);
    expect(locks()).toHaveLength(1);
    await placeOne('territory_lock', -700, 0);
    expect(locks()).toHaveLength(1);
    await noticeOf(LOCK_TAKEN_REASON);

    // 3. It builds from the capital bank (via the relay), draining its full cost.
    const lock = locks()[0]!;
    const relay = [...reg.all()].find((s) => s.kind === 'connector')!;
    for (let i = 0; i < 100 && !relay.isConstructed; i++) internals.pulseStructureGrid();
    // The room's own 1 Hz pulse may have built a few units already.
    const owed = TERRITORY_LOCK_COST - lock.constructionProgress;
    expect(owed).toBeGreaterThan(TERRITORY_LOCK_COST - 100);
    cap.minerals = 50_000;
    for (let i = 0; i < TERRITORY_LOCK_COST / CONSTRUCTION_PULSE_AMOUNT + 5 && !lock.isConstructed; i++) internals.pulseStructureGrid();
    expect(lock.isConstructed).toBe(true);
    expect(cap.minerals).toBe(50_000 - owed);

    // 4. A big robot force can't take the locked sector...
    robots.set(KEY, 30);
    run(300);
    expect(territory.sectorOwner(KEY)).toEqual({ factionId: side, contested: true });
    // ...until the lock is destroyed.
    internals.applyDamage(lock.id, 'swarm-99', 999_999);
    expect(locks()).toHaveLength(0);
    run(300);
    expect(territory.sectorOwner(KEY)?.factionId).toBe('robots');
  }, 30_000);
});
