/**
 * RTS Part A — another player's AI-flown ship is lockable like any player's
 * ship (owner decision: "You're flying, and another player's ship flown by an
 * AI pilot crosses your lock line → yes, lock it like any player's ship").
 *
 * The player lock key `p:<id>` names a pilot's ACTIVE ship by playerId, or a
 * parked (AI-flown) hull by its shipInstanceId: the key the client's one ship
 * list already uses for that hull. `SectorRoom.resolveLockTarget` is the one
 * resolver; the rules are the active-ship rules (another player: failsafe
 * first, then locked; your own ship: never lockable).
 *
 * Failing-first: before this slice `p:<shipInstanceId>` resolved nothing, so
 * the lock never appeared and no shot at the hull was accepted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('SectorRoom integration — AI-flown player ships are lockable (RTS Part A)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  const room = (): SectorRoom => harness.getServerRoom() as unknown as SectorRoom;
  const activeSidOf = (pid: string): string => {
    for (const [, s] of (room().state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  };
  /** Track the shooter's own `groups` slice. */
  function watchGroups(c: ClientRoom<SectorState>, pid: string): () => SnapGroups[] | undefined {
    let groups: SnapGroups[] | undefined;
    c.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; isActive?: boolean; groups?: SnapGroups[] }> }) => {
      for (const s of Object.values(snap.states ?? {})) if (s.playerId === pid && s.isActive !== false) groups = s.groups;
    });
    return () => groups;
  }

  it('pilot A locks pilot B\'s AI-flown hull (failsafe, then locked) and the shot lands', { timeout: 40_000 }, async () => {
    // B parks its ship (Command view): the hull is AI-flown at (0, 180).
    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 180, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const hull = activeSidOf(bPid);
    expect(hull).not.toBe('');
    b.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.lingeringSlots.has(hull), 3000, 'B\'s hull is parked');
    expect(room()._internals.fleet.isAttached(hull), 'the hull is AI-flown').toBe(true);
    // Hold its fire so the scene stays still (Defend at the parking spot).
    room()._internals.fleet.setStance(bPid, [hull], 'holdFire');

    const aPid = randomUUID();
    const a = (await harness.connectActive(aPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const groups = watchGroups(a, aPid);
    const hits: DamageEvent[] = [];
    a.onMessage('damage', (e: DamageEvent) => { if (e.targetId === hull) hits.push(e); });

    const key = `p:${hull}`;
    a.send('lock_request', { type: 'lock_request', groupId: 'primary', target: key });
    await waitUntil(() => (groups()?.[0]?.l.some((l) => l.t === key) ?? false), 3000, 'the lock on the hull appears');
    // Another player's ship: the failsafe first, then a logged hostile act, then LOCKED.
    expect(groups()![0]!.l.find((l) => l.t === key)!.s).toBe(0);
    await harness.events.waitFor({ tag: 'lock_hostile_act', where: (d) => d['playerId'] === aPid && d['target'] === key }, { timeoutMs: 12_000 });
    await waitUntil(() => groups()?.[0]?.l.find((l) => l.t === key)?.s === 2, 12_000, 'locked on the hull');

    for (let i = 0; i < 6 && hits.length === 0; i++) {
      a.send('fire', {
        type: 'fire', tick: room()._internals.serverTick, clientShotId: `s${i}`,
        weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(400);
    }
    expect(hits.length, 'the locked shot damaged B\'s AI-flown hull').toBeGreaterThan(0);
  });

  // RTS Part B slice 8: the attack order reaches the AI pilot brain; until then the hull never locks the named hull.
  it.skip('an AI pilot ordered to attack another player\'s AI-flown hull locks it and hits it', { timeout: 40_000 }, async () => {
    // B's hull parked ahead of A's; A parks too: both ships AI-flown.
    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 180, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const target = activeSidOf(bPid);
    b.send('spectate', { type: 'spectate' });
    const aPid = randomUUID();
    const a = (await harness.connectActive(aPid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    const wing = activeSidOf(aPid);
    a.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.lingeringSlots.has(target) && room()._internals.lingeringSlots.has(wing), 3000, 'both parked');
    const fleet = room()._internals.fleet;
    fleet.setStance(bPid, [target], 'holdFire');
    fleet.setStance(aPid, [wing], 'aggressive');
    expect(fleet.applyOrder(aPid, [wing], { kind: 'attack', targetId: target })).toEqual([wing]);

    const start = (room().state as SectorState).ships.get(target)!.health;
    let lost = 0;
    for (let i = 0; i < 60 && lost <= 0; i++) {
      await harness.advance(250);
      lost = start - ((room().state as SectorState).ships.get(target)?.health ?? 0);
    }
    expect(lost, 'the AI pilot locked and damaged the other player\'s hull').toBeGreaterThan(0);
  });

  it('your own AI-flown ship is never lockable, by request or by AUTO', { timeout: 40_000 }, async () => {
    // Owner O: hull H displaced by a fresh spawn (AI-flown), then O flies a new ship.
    const oPid = randomUUID();
    let o = (await harness.connectActive(oPid, { shipKind: 'fighter', spawnX: 0, spawnY: 180 })) as ClientRoom<SectorState>;
    const own = activeSidOf(oPid);
    await harness.disconnectClient(o);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === oPid });
    o = (await harness.connectActive(oPid, {
      isNewShip: true, shipKind: 'interceptor', spawnX: 0, spawnY: 0, instantLock: true, anyTarget: true,
    })) as ClientRoom<SectorState>;
    expect(activeSidOf(oPid)).not.toBe(own);
    expect(room()._internals.lingeringSlots.has(own), 'the old ship is parked').toBe(true);
    const groups = watchGroups(o, oPid);

    // AUTO (default mode, anyTarget + instantLock): never picks its own ship.
    await harness.advance(800);
    const key = `p:${own}`;
    expect(groups()?.some((g) => g.l.some((l) => l.t === key)) ?? false, 'AUTO locked its own ship').toBe(false);
    // An explicit request is refused too.
    o.send('lock_request', { type: 'lock_request', groupId: 'primary', target: key });
    await harness.advance(800);
    expect(groups()?.some((g) => g.l.some((l) => l.t === key)) ?? false, 'a lock on its own ship').toBe(false);
  });
});
