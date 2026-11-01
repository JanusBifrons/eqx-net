/**
 * Living World P4b (plan peppy-jumping-pinwheel) — WORLD EVENTS over real
 * SectorRooms.
 *
 *  1. an incursion spawns a hostile robot strike group; wiping it out drops a
 *     reward cache (cores) and ends the event, with galaxy-wide notices;
 *  2. a mothership is a 6×-hull named carrier with escorts; killing it ends
 *     the event and drops the elite haul; the escorts leave;
 *  3. a salvage field scatters rich pods; an unfinished event fades on its
 *     deadline, removing survivors quietly;
 *  4. the galaxy hook reports the running event in its sector only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { EventDirector, MOTHERSHIP_NAME } from '../../../src/server/livingworld/EventDirector.js';
import { MOTHERSHIP_HEALTH_MUL, SALVAGE_POD_COUNT } from '../../../src/shared-types/worldEvents.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import type { WorldNotice } from '../../../src/shared-types/worldNotice.js';

describe('SectorRoom integration — world events (P4b)', () => {
  let h: LivingWorldTestHarness | undefined;
  let ev: EventDirector | undefined;
  afterEach(async () => {
    ev?.stop();
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  async function boot(): Promise<{ h: LivingWorldTestHarness; ev: EventDirector; clock: { now: number } }> {
    const harness = await bootLivingWorldTestServer({ sectors: ['greenfall', 'emerald-span'], botCount: 0, seed: 5 });
    const clock = { now: 1_000_000 };
    const rooms = new Map<string, LivingWorldRoom>([
      ['greenfall', harness.getRoom('greenfall') as unknown as LivingWorldRoom],
      ['emerald-span', harness.getRoom('emerald-span') as unknown as LivingWorldRoom],
    ]);
    const director = new EventDirector(rooms, { nowMs: () => clock.now, intervalMs: 60_000 });
    director.start();
    return { h: harness, ev: director, clock };
  }

  function eventMobs(sectorKey: string): string[] {
    const out: string[] = [];
    for (const rec of h!.getRoom(sectorKey)._internals.swarmRegistry.all()) {
      if (rec.id.startsWith('event-')) out.push(rec.id);
    }
    return out;
  }

  function podSum(sectorKey: string, pick: (p: { goods: Record<string, number | undefined>; credits: number }) => number): number {
    return getHoldStore().inSector(sectorKey, 'pod').reduce((s, p) => s + pick(p.hold), 0);
  }

  it('an incursion is a robot strike group; wiping it out drops a cache and ends it', { timeout: 40_000 }, async () => {
    ({ h, ev } = await boot());
    const room = h.getRoom('greenfall');
    const pilot = await h.connectActive(randomUUID(), 'greenfall', { initialHull: 99999 });
    const notices: WorldNotice[] = [];
    pilot.onMessage('world_notice', (n: WorldNotice) => notices.push(n));

    expect(ev.startEvent('incursion', 'greenfall')).toBe(true);
    expect(ev.startEvent('salvage', 'greenfall')).toBe(false); // one at a time
    const mobs = eventMobs('greenfall');
    expect(mobs).toHaveLength(6);
    expect(mobs.every((id) => room._internals.swarmRegistry.get(id)?.shipKind?.startsWith('robot-'))).toBe(true);
    expect(ev.sectorEvent('greenfall')?.kind).toBe('incursion');
    expect(ev.sectorEvent('emerald-span')).toBeNull();

    const coresBefore = podSum('greenfall', (p) => p.goods['core'] ?? 0);
    for (const id of mobs) {
      for (let i = 0; i < 30 && room._internals.swarmRegistry.get(id); i++) room._internals.applyDamage(id, 'some-player', 5_000);
    }
    expect(eventMobs('greenfall')).toHaveLength(0);
    expect(ev.activeEvent()).toBeNull();
    // The cache (1–3 cores) on top of whatever the robots' own tables dropped.
    expect(podSum('greenfall', (p) => p.goods['core'] ?? 0) - coresBefore).toBeGreaterThanOrEqual(1);
    await h.waitUntil(
      () => notices.some((n) => n.kind === 'event_started') && notices.some((n) => n.kind === 'event_ended'),
      3000, 'start + end notices',
    );
  });

  it('a mothership is a 6× named carrier; its kill ends the event and the escorts leave', { timeout: 40_000 }, async () => {
    ({ h, ev } = await boot());
    const room = h.getRoom('greenfall');
    expect(ev.startEvent('mothership', 'greenfall')).toBe(true);
    const mobs = eventMobs('greenfall');
    const boss = mobs.find((id) => id.endsWith('-boss'))!;
    const rec = room._internals.swarmRegistry.get(boss)!;
    expect(rec.elite?.name).toBe(MOTHERSHIP_NAME);
    expect(rec.elite?.maxHealth).toBe(getShipKind('missile-frigate').maxHealth * MOTHERSHIP_HEALTH_MUL);
    expect(mobs.length).toBe(5); // boss + 4 escorts

    for (let i = 0; i < 40 && room._internals.swarmRegistry.get(boss); i++) room._internals.applyDamage(boss, 'some-player', 5_000);
    expect(ev.activeEvent()).toBeNull();
    expect(eventMobs('greenfall')).toHaveLength(0); // escorts warped out
    expect(podSum('greenfall', (p) => p.goods['core'] ?? 0)).toBeGreaterThanOrEqual(1); // the elite haul
  });

  it('a salvage field scatters rich pods; an unfinished event fades on its deadline', { timeout: 40_000 }, async () => {
    let clock: { now: number };
    ({ h, ev, clock } = await boot());
    const podsBefore = getHoldStore().inSector('emerald-span', 'pod').length;
    expect(ev.startEvent('salvage', 'emerald-span')).toBe(true);
    expect(getHoldStore().inSector('emerald-span', 'pod').length - podsBefore).toBeGreaterThanOrEqual(1);
    expect(podSum('emerald-span', (p) => p.goods['salvage'] ?? 0)).toBeGreaterThanOrEqual(SALVAGE_POD_COUNT * 20);

    // A second event can't start while it runs; after it fades, the lull runs.
    clock.now += 6 * 60_000;
    ev.tick(clock.now);
    expect(ev.activeEvent()).toBeNull();
    ev.tick(clock.now + 1000);
    expect(ev.activeEvent()).toBeNull(); // still in the lull

    // An incursion left alone fades: its raiders leave quietly.
    expect(ev.startEvent('incursion', 'greenfall', clock.now)).toBe(true);
    expect(eventMobs('greenfall').length).toBeGreaterThan(0);
    clock.now += 11 * 60_000;
    ev.tick(clock.now);
    expect(ev.activeEvent()).toBeNull();
    expect(eventMobs('greenfall')).toHaveLength(0);
  });
});
