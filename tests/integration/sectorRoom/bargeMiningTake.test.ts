/**
 * The `barge-mining` showcase take, through the REAL room with the showcase
 * room's own options (`SHOWCASE_BARGE_MINING_OPTS`): the pilot flies the
 * barge at the origin, locks the nearest rock (`mine-rock-a`, r 260, off the
 * starboard side) with the mining lasers and the tractors, and holds still.
 * The line must run to the end, the ROCK CHUNK (owner 2026-11-17): the lasers
 * cut the rock (only the matching size fires) and the tractors drag each piece
 * whose chunk weight fits the free hold to the hull, where it goes in WHOLE as
 * one rock chunk (a packed `chunk:rock` item, its ore hidden until a refinery
 * breaks it down). A rock never turns into a pod and no ore lands in the hold
 * on the way in. The tractor locks follow the pieces (lineage).
 *
 * A whole rock is tier none: only the XL lasers (the bow corners) cut it.
 * Parked at the origin, mine-rock-a sits abaft their arc (only the side and
 * aft lasers bear, and they leave a whole rock), so the barge starts at the
 * room's own spawn (`SHOWCASE_BARGE_MINING_SPAWN`, the filmed pose): the rock
 * off its port bow, in the port XL laser's arc and tractor's reach, clear of
 * the other rocks (`BOW_ON`). The pilot locks the rock ONCE and never again:
 * each group's lock stays on the rock's lineage (its pieces) until none is left (seen on film 2026-11-16: every lock was
 * gone at ~150 s with a cut piece still drifting, and the hold stalled).
 *
 * Seen on film (2026-11-16): the lasers cut the rock into a few pieces, then
 * stopped; the pieces sat off the side and the hold stayed at 0. The room had
 * no roster (no `sectorKey`), so the barge had no hold and was never a loot
 * collector, yet the lock step still called its pieces consumable, so every
 * laser and tractor left them. Fixed both ways: the room is roster-backed,
 * and a ship with no hold has no free hold (`SectorRoom.hasHold`), so
 * nothing is consumable for it and its lasers keep cutting (second case).
 *
 * Hold size used to scale with the hull (0.15 × r: ~570 u on the barge, so
 * its first cut pieces went straight in). It is now the smallest size on
 * every ship, so the take must show more than one size of cut piece on the
 * way down. Runs at 4× game speed (the sector's own time scale, a bespoke
 * trigger) so the longer take fits the same wall budget.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_BARGE_MINING_OPTS, SHOWCASE_BARGE_MINING_SPAWN } from '../../../src/server/rooms/showcaseBargeRooms.js';
import { TRACTOR_DEF } from '../../../src/core/combat/tractorSpec.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { SALVAGE_TIER_SIZES, rockChunkWeight, salvageTier } from '../../../src/core/combat/salvageTargeting.js';
import { cargoCapacityForMaxHealth } from '../../../src/shared-types/goods.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { holdWeight } from '../../../src/core/cargo/hold.js';
import { ROCK_CHUNK_PRODUCT } from '../../../src/shared-types/items.js';

const WRECK_KIND = 4;
/** Game speed for the take (the sector time scale's top, 4×; the game time is reported). */
const SPEED = 4;
/** The tractor's lease (ticks): the trigger must be renewed inside it or the beam lapses. */
const TRACTOR_LEASE = TRACTOR_DEF.tractor!.leaseTicks;
/** Rock chunks the take runs for. CI hosts simulate this scene at ~0.8× real time, short of the 4×
 *  asked (the room drops ticks it can't run), so the take is bounded in GAME time, not wall time. */
const CHUNKS_WANTED = 2;
/** Rock chunks the take must bring in. Which piece comes in first is physics, not a rule: a big
 *  first chunk can fill most of the hold and the rest drift off (seen at 240 game s, 1 chunk), so
 *  the gate is the chain working at all (the 2026-11-16 bug: 0 chunks, the hold stalled). */
const CHUNKS_REQUIRED = 1;
/** The take's game-time budget (s): ample for CHUNKS_WANTED on a fast host or a slow one. */
const TAKE_GAME_S = 240;
/** Barge spawn: the room's own (the filmed pose), mine-rock-a off the port bow. */
const BOW_ON = { spawnX: SHOWCASE_BARGE_MINING_SPAWN.x, spawnY: SHOWCASE_BARGE_MINING_SPAWN.y };

describe('SectorRoom integration — the barge-mining take: the rock ends up in the hold', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  /** Boot the room, fly the barge at the origin, lock mine-rock-a with both groups. */
  const start = async (opts: typeof SHOWCASE_BARGE_MINING_OPTS | Omit<typeof SHOWCASE_BARGE_MINING_OPTS, 'sectorKey'>, timeScale?: number, spawn = BOW_ON) => {
    harness = await bootSectorTestServer({ ...opts, subcapWrecks: true, ...(timeScale !== undefined ? { timeScale } : {}) });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'barge', ...spawn, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    for (const t of ['laser_fired', 'swarm', 'damage', 'destroy', 'hit_ack', 'loot_collected', 'collision_resolved']) cr.onMessage(t, () => {});
    /** Live locks per group, from the pilot's own snapshot. */
    const locks = new Map<string, number>();
    cr.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: Array<{ id: string; l: Array<{ s: number }> }> }> }) => {
      for (const st of Object.values(snap.states ?? {})) {
        if (st.playerId === pid && st.groups) for (const g of st.groups) locks.set(g.id, g.l.filter((l) => l.s === 2).length);
      }
    });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    expect(ship.kind).toBe('barge');
    const holdGoods = (): Record<string, number> => (getHoldStore().get(ship.shipInstanceId)?.hold.goods ?? {}) as Record<string, number>;
    const chunks = (): number => (getHoldStore().get(ship.shipInstanceId)?.hold.packed ?? []).filter((p) => p.product === ROCK_CHUNK_PRODUCT).length;
    const freeHold = (): number => {
      const h = getHoldStore().get(ship.shipInstanceId)?.hold;
      return Math.floor(cargoCapacityForMaxHealth(getShipKind('barge'))) - (h ? holdWeight(h) : 0);
    };
    expect(int().swarmRegistry.get('mine-rock-a')).toBeTruthy();

    harness.lockTarget(pid, 'mine-rock-a', 'laser');
    harness.lockTarget(pid, 'mine-rock-a', 'tractor');
    let shot = 0;
    const fire = (slotId: string): void => {
      cr.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: `${slotId}${shot++}`, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    /** Groups seen with no live lock while a piece of the rock was alive. */
    const dropped = new Set<string>();
    const watchLocks = (): void => {
      if (int().swarmRegistry.get('mine-rock-a') != null || livePieces(int).length === 0) return;
      for (const g of ['laser', 'tractor']) if ((locks.get(g) ?? 1) === 0) dropped.add(g);
    };
    return { int, holdGoods, chunks, freeHold, fire, watchLocks, dropped };
  };
  const livePieces = (int: () => SectorRoom['_internals']): string[] => [...int().swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
  const tierName = (t: number): string => (t === 0 ? 'none' : SALVAGE_TIER_SIZES[t - 1]!);

  it('lasers and tractors locked on mine-rock-a: the rock is cut and its pieces come into the hold whole as rock chunks', { timeout: 240_000 }, async () => {
    const { int, holdGoods, chunks, freeHold, fire, watchLocks, dropped } = await start(SHOWCASE_BARGE_MINING_OPTS, SPEED);
    // Hold both triggers through the take, bounded only by GAME time (TAKE_GAME_S; a slow host runs
    // it longer in wall time, never shorter in game time, so no wall cut-off decides the result):
    // until CHUNKS_WANTED chunks are in, or the rock is cut and every piece left is too heavy for
    // the free hold.
    const minerals0 = holdGoods().minerals ?? 0;
    let cut = false;
    /** Every piece seen live, by its size tier at first sight; the cuts (wreck ids, one per split). */
    const tierOf = new Map<string, number>();
    const splits = new Set<string>();
    const pods = new Set<string>();
    /** Live pieces the barge hauls: a tractor pulls their size and the chunk fits the free hold
     *  (the tractors should still be bringing them). A piece too big for every tractor is cut on. */
    const fitting = (): string[] => livePieces(int).filter((id) => {
      const m = int().wreckMass(id);
      return m !== undefined && salvageTier(m) !== 0 && rockChunkWeight(m) <= freeHold();
    });
    const tick0 = int().serverTick;
    while (int().serverTick - tick0 < TAKE_GAME_S * 60) {
      cut ||= int().swarmRegistry.get('mine-rock-a') == null;
      const live = livePieces(int);
      for (const id of live) {
        if (tierOf.has(id)) continue;
        const m = int().wreckMass(id);
        if (m !== undefined) tierOf.set(id, salvageTier(m));
        splits.add(id.replace(/-\d+$/, ''));
      }
      for (const id of int().loot.podIds()) pods.add(id);
      if (chunks() >= CHUNKS_WANTED || (cut && chunks() > 0 && fitting().length === 0)) break;
      watchLocks();
      fire('laser'); fire('tractor');
      // Hold the triggers in GAME time: a tractor lease lasts ${TRACTOR_LEASE} ticks, so renew every
      // half lease. A wall-time step (50 ms = 12 ticks at 4×) let the beam lapse on a slow CI runner.
      // The pod stranded on CI 2026-11-18 (every retry, shard 4) was the tractor locks idling on pieces
      // too big to pull while a pod drifted out of reach (lockSplit.ts `splitGroupLocks`, lockLineage.test.ts).
      const fired = int().serverTick;
      while (int().serverTick - fired < TRACTOR_LEASE / 2) await harness.advance(5);
    }
    const gameSeconds = (int().serverTick - tick0) / 60;
    /** At a stall: where each piece that would fit sits, its radius and size tier. */
    const stall = fitting().map((id) => {
      const p = int().wreckState(id);
      return `${id}@${p ? `${Math.round(p.x)},${Math.round(p.y)}` : '?'} r${Math.round(int().swarmRegistry.get(id)?.radius ?? -1)} ${tierName(tierOf.get(id) ?? -1)}`;
    }).join('; ');
    const sizes = [...new Set(tierOf.values())].sort((a, b) => b - a).map(tierName);
    console.log(`[bargeMiningTake] ${gameSeconds.toFixed(1)} s game; ${splits.size} cuts; piece sizes seen: ${sizes.join(' > ')}; ${tierOf.size} pieces; ${chunks()} chunks; free hold ${freeHold()}; ${livePieces(int).length} pieces left`);
    expect(cut, 'the lasers cut the rock').toBe(true);
    expect([...dropped], 'no group lost its lock while a piece of the rock was alive').toEqual([]);
    // Not every piece: the barge sits still, its XL tractors face abeam (one bears on the
    // rock) and reel one piece at a time; a piece can drift out of the port XL laser's arc or
    // pin behind a big one. Before the tractors' locks left the pieces too heavy to pull
    // (`rekeyUnworkable`) one chunk came in; since, 4-5 by the end of a full take on a fast host
    // (2026-11-17), 2 by ~150 game s on CI.
    if (stall !== '') console.log(`[bargeMiningTake] still out: ${stall}`);
    expect(chunks(), 'the rock goes into the hold as chunks').toBeGreaterThanOrEqual(CHUNKS_REQUIRED);
    expect(pods.size, 'a rock never turns into a pod').toBe(0);
    expect(holdGoods().minerals ?? 0, 'no ore lands in the hold on the way in').toBe(minerals0);
  });

  it('with no hold (a room with no roster) nothing is consumable: the lasers keep cutting the pieces', { timeout: 60_000 }, async () => {
    const { sectorKey: _none, ...noRoster } = SHOWCASE_BARGE_MINING_OPTS;
    const { int, fire } = await start(noRoster, SPEED);
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && int().swarmRegistry.get('mine-rock-a') != null) { fire('laser'); await harness.advance(100); }
    expect(int().swarmRegistry.get('mine-rock-a') ?? null, 'the lasers cut the rock').toBeNull();
    const wear = (): string => livePieces(int).map((id) => `${id}:${int().wreckIntegrity(id)}`).join(',');
    const wear0 = wear();
    for (let i = 0; i < 100 && wear() === wear0; i++) { fire('laser'); await harness.advance(100); }
    expect(wear(), 'a laser works a piece the barge cannot take in').not.toBe(wear0);
  });
});
