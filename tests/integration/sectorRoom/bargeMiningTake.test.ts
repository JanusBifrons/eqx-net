/**
 * The `barge-mining` showcase take, through the REAL room with the showcase
 * room's own options (`SHOWCASE_BARGE_MINING_OPTS`): the pilot flies the
 * barge at the origin, locks the nearest rock (`mine-rock-a`, r 260, off the
 * starboard side) with the mining lasers and the tractors, and holds still.
 * The factory line must run to the end: the lasers cut the rock, and the
 * pieces small enough for the barge to take in (consumable) go into its hold.
 *
 * Seen on film (2026-11-16): the lasers cut the rock into a few pieces, then
 * stopped; the pieces sat off the side and the hold stayed at 0. The room had
 * no roster (no `sectorKey`), so the barge had no hold and was never a loot
 * collector, yet the lock step still called its pieces consumable, so every
 * laser and tractor left them. Fixed both ways: the room is roster-backed,
 * and a ship with no hold has no free hold (`SectorRoom.hasHold`), so
 * nothing is consumable for it and its lasers keep cutting (second case).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_BARGE_MINING_OPTS } from '../../../src/server/rooms/showcaseBargeRooms.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { SALVAGE_CONSUME_FRAC } from '../../../src/core/combat/salvageTargeting.js';

const WRECK_KIND = 4;

describe('SectorRoom integration — the barge-mining take: the rock ends up in the hold', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  /** Boot the room, fly the barge at the origin, lock mine-rock-a with both groups. */
  const start = async (opts: typeof SHOWCASE_BARGE_MINING_OPTS | Omit<typeof SHOWCASE_BARGE_MINING_OPTS, 'sectorKey'>) => {
    harness = await bootSectorTestServer({ ...opts, subcapWrecks: true });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'barge', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    for (const t of ['snapshot', 'laser_fired', 'swarm', 'damage', 'destroy', 'hit_ack', 'loot_collected', 'collision_resolved']) cr.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    expect(ship.kind).toBe('barge');
    const holdGoods = (): Record<string, number> => (getHoldStore().get(ship.shipInstanceId)?.hold.goods ?? {}) as Record<string, number>;
    expect(int().swarmRegistry.get('mine-rock-a')).toBeTruthy();

    harness.lockTarget(pid, 'mine-rock-a', 'laser');
    harness.lockTarget(pid, 'mine-rock-a', 'tractor');
    let shot = 0;
    const fire = (slotId: string): void => {
      cr.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: `${slotId}${shot++}`, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    return { int, holdGoods, fire };
  };
  const livePieces = (int: () => SectorRoom['_internals']): string[] => [...int().swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);

  it('lasers and tractors locked on mine-rock-a: the rock is cut and every piece goes into the hold', { timeout: 90_000 }, async () => {
    const { int, holdGoods, fire } = await start(SHOWCASE_BARGE_MINING_OPTS);
    // Hold both triggers through the take (40 s): until the rock is cut and no piece is left in the world.
    let cut = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 40_000) {
      cut ||= int().swarmRegistry.get('mine-rock-a') == null;
      if (cut && livePieces(int).length === 0) break;
      fire('laser'); fire('tractor');
      await harness.advance(100);
    }
    /** At a stall: where each piece sits and its radius (against the barge's consume radius). */
    const stall = livePieces(int).map((id) => {
      const p = int().wreckState(id);
      return `${id}@${p ? `${Math.round(p.x)},${Math.round(p.y)}` : '?'} r${Math.round(int().swarmRegistry.get(id)?.radius ?? -1)}`;
    }).join('; ');
    const kind = getShipKind('barge');
    expect(cut, 'the lasers cut the rock').toBe(true);
    expect(stall, `every piece taken in (consume r ${Math.round(SALVAGE_CONSUME_FRAC * kind.radius)}, hull r ${Math.round(kind.radius)})`).toBe('');
    expect(holdGoods().minerals ?? 0, 'the rock is ore in the hold').toBeGreaterThan(0);
  });

  it('with no hold (a room with no roster) nothing is consumable: the lasers keep cutting the pieces', { timeout: 60_000 }, async () => {
    const { sectorKey: _none, ...noRoster } = SHOWCASE_BARGE_MINING_OPTS;
    const { int, fire } = await start(noRoster);
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && int().swarmRegistry.get('mine-rock-a') != null) { fire('laser'); await harness.advance(100); }
    expect(int().swarmRegistry.get('mine-rock-a') ?? null, 'the lasers cut the rock').toBeNull();
    const wear = (): string => livePieces(int).map((id) => `${id}:${int().wreckIntegrity(id)}`).join(',');
    const wear0 = wear();
    for (let i = 0; i < 100 && wear() === wear0; i++) { fire('laser'); await harness.advance(100); }
    expect(wear(), 'a laser works a piece the barge cannot take in').not.toBe(wear0);
  });
});
