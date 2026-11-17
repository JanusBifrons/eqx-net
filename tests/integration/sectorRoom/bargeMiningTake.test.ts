/**
 * The `barge-mining` showcase take, through the REAL room with the showcase
 * room's own options (`SHOWCASE_BARGE_MINING_OPTS`): the pilot flies the
 * barge at the origin, locks the nearest rock (`mine-rock-a`, r 260, off the
 * starboard side) with the mining lasers and the tractors, and holds still.
 * The line must run to the end, the ORE POD (owner 2026-11-16): the lasers
 * cut the rock (only the matching size fires) until its pieces wear out
 * under the rock's re-split floor into ore pods; a rock piece never goes in
 * whole. The tractor locks follow the pieces and then their pods (lineage),
 * every tractor pulls a pod, and a pod goes into the hold in the tractor's
 * hold zone or when it touches the hull.
 *
 * A whole rock is tier none: only the XL lasers (the bow corners) cut it.
 * Parked at the origin, mine-rock-a sits abaft their arc (only the side and
 * aft lasers bear, and they leave a whole rock), so the barge starts at the
 * room's own spawn (`SHOWCASE_BARGE_MINING_SPAWN`, the filmed pose): the rock
 * off its port bow, in the port XL laser's arc and tractor's reach, clear of
 * the other rocks (`BOW_ON`). The pilot locks the rock ONCE and never again:
 * each group's lock stays on the rock's lineage (its pieces, and its pods for
 * the tractors) until none is left (seen on film 2026-11-16: every lock was
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
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { SALVAGE_TIER_SIZES, salvageTier } from '../../../src/core/combat/salvageTargeting.js';

const WRECK_KIND = 4;
/** Game speed for the take (the sector time scale's top, 4×; the game time is reported). */
const SPEED = 4;
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
    return { int, holdGoods, fire, watchLocks, dropped };
  };
  const livePieces = (int: () => SectorRoom['_internals']): string[] => [...int().swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
  const tierName = (t: number): string => (t === 0 ? 'none' : SALVAGE_TIER_SIZES[t - 1]!);

  it('lasers and tractors locked on mine-rock-a: the rock is cut down to ore pods and every pod goes into the hold', { timeout: 120_000 }, async () => {
    const { int, holdGoods, fire, watchLocks, dropped } = await start(SHOWCASE_BARGE_MINING_OPTS, SPEED);
    // Hold both triggers through the take (60 s wall, up to ~240 s game): until the rock is cut and no piece is left in the world.
    let cut = false;
    /** Every piece seen live, by its size tier at first sight; the cuts (wreck ids, one per split). */
    const tierOf = new Map<string, number>();
    const splits = new Set<string>();
    const pods = new Set<string>();
    const tick0 = int().serverTick;
    /** Pods lost on the way in (seen on film 2026-11-17: tractored pods hit the hull and died to their ram damage, uncredited). */
    const lost: string[] = [];
    const loot = int().loot;
    const podDestroyed = loot.onPodDestroyed.bind(loot);
    loot.onPodDestroyed = (id: string): void => { lost.push(id); podDestroyed(id); };
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      cut ||= int().swarmRegistry.get('mine-rock-a') == null;
      const live = livePieces(int);
      for (const id of live) {
        if (tierOf.has(id)) continue;
        const m = int().wreckMass(id);
        if (m !== undefined) tierOf.set(id, salvageTier(m));
        splits.add(id.replace(/-\d+$/, ''));
      }
      for (const id of int().loot.podIds()) pods.add(id);
      if (cut && live.length === 0 && int().loot.podCount() === 0) break;
      watchLocks();
      fire('laser'); fire('tractor');
      await harness.advance(50);
    }
    const gameSeconds = (int().serverTick - tick0) / 60;
    /** At a stall: where each piece sits, its radius and size tier. */
    const stall = livePieces(int).map((id) => {
      const p = int().wreckState(id);
      return `${id}@${p ? `${Math.round(p.x)},${Math.round(p.y)}` : '?'} r${Math.round(int().swarmRegistry.get(id)?.radius ?? -1)} ${tierName(tierOf.get(id) ?? -1)}`;
    }).join('; ');
    const sizes = [...new Set(tierOf.values())].sort((a, b) => b - a).map(tierName);
    console.log(`[bargeMiningTake] ${gameSeconds.toFixed(1)} s game; ${splits.size} cuts; piece sizes seen: ${sizes.join(' > ')}; ${tierOf.size} pieces; ${pods.size} pods; hold ${JSON.stringify(holdGoods())}`);
    expect(cut, 'the lasers cut the rock').toBe(true);
    expect([...dropped], 'no group lost its lock while a piece of the rock was alive').toEqual([]);
    expect(stall, 'every piece cut down to ore pods').toBe('');
    expect(pods.size, 'the line ends in ore pods').toBeGreaterThan(0);
    expect(int().loot.podCount(), 'every pod taken in').toBe(0);
    expect(lost, 'no pod destroyed on the way in').toEqual([]);
    expect(holdGoods().minerals ?? 0, 'the rock is ore in the hold').toBeGreaterThan(0);
    expect(splits.size, 'several cut generations').toBeGreaterThan(1);
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
