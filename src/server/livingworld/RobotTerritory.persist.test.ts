/**
 * Step 1c — sector control survives a restart. `RobotTerritory` saves each
 * sector's control meter that differs from its seed into the robot director's
 * state row (`DirectorStatePayload.sectorControl`), and a fresh territory built
 * after the restart restores it. Old rows (no control) and malformed entries
 * fall back to the `sectorController` seeds. The director wiring (persist →
 * hydrate inside `start()`) is locked in
 * tests/integration/sectorRoom/livingWorldDirectorPersistence.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { RobotTerritory } from './RobotTerritory.js';
import type { FactionPresenceMap } from './factionPresence.js';
import type { LivingWorldRoom, SectorLiveCounts } from './LivingWorldRoom.js';
import {
  DIRECTOR_STATE_VERSION,
  DirectorPersistence,
  type DirectorStatePayload,
} from './DirectorPersistence.js';

const noopLogger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function mockRoom(byFaction: () => FactionPresenceMap): LivingWorldRoom {
  const bus = new Bus();
  return {
    eventBus: () => bus,
    playerCount: () => 0,
    hasFreeSlot: () => false,
    liveCounts: (): SectorLiveCounts => ({ players: 0, enemies: 0, neutrals: 0, structures: 0, byFaction: byFaction() }),
  } as unknown as LivingWorldRoom;
}

const SECTORS = ['sol-prime', 'bloomgate', 'orion-belt'] as const;

function build(presence: Record<string, FactionPresenceMap> = {}) {
  const clock = { now: 0 };
  const rooms = new Map<string, LivingWorldRoom>();
  for (const key of SECTORS) rooms.set(key, mockRoom(() => presence[key] ?? new Map()));
  const t = new RobotTerritory(rooms, () => new Map(), { nowMs: () => clock.now, nexusSector: '__none__' });
  t.start();
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; t.tick(clock.now); }
  };
  return { t, run };
}

/** The persisted row the robot director writes, round-tripped through JSON. */
function rowStore() {
  let row: { payload_json: string; created_at: number } | undefined;
  const dp = new DirectorPersistence({
    saveRow: (p) => { row = { payload_json: JSON.stringify(p), created_at: Date.now() }; },
    loadRow: () => row,
    logger: noopLogger,
  });
  const base = (): DirectorStatePayload => ({
    version: DIRECTOR_STATE_VERSION, savedAtMs: 0, squads: [], waveCount: [], lastDispatchAtMs: [],
  });
  return { dp, base, setRaw: (json: string) => { row = { payload_json: json, created_at: Date.now() }; } };
}

const sides = (o: Record<string, number>): FactionPresenceMap =>
  new Map(Object.entries(o).map(([k, ships]) => [k, { ships, structures: 0 }]));

describe('RobotTerritory — sector control persists across a restart', () => {
  it('a captured sector is saved and restored by a fresh territory', () => {
    const { t, run } = build({ 'orion-belt': sides({ alice: 6 }), 'sol-prime': sides({ bob: 5 }) });
    run(90); // alice takes orion-belt; bob fights for Sol's sector
    expect(t.sectorOwner('orion-belt')?.factionId).toBe('alice');
    const saved = t.saveControl();
    t.stop();
    // Only sectors that left their seed are saved (bloomgate is untouched).
    expect(saved.map((e) => e.sectorKey).sort()).toEqual(['orion-belt', 'sol-prime']);
    for (const e of saved) {
      for (const [, v] of e.shares) {
        expect(v).toBeGreaterThanOrEqual(0.5);
        expect(Math.round(v * 10) / 10).toBe(v);
      }
    }

    const { dp, base } = rowStore();
    dp.persist({ ...base(), sectorControl: saved });
    const hydrated = dp.hydrate();
    expect(hydrated?.sectorControl).toEqual(saved);

    // "Restart": a fresh territory (seeded) overlaid with the saved control.
    const { t: t2 } = build();
    t2.restoreControl(hydrated!.sectorControl!);
    expect(t2.sectorOwner('orion-belt')?.factionId).toBe('alice');
    expect(t2.sectorOwner('bloomgate')?.factionId).toBe('verdant-reach');
    // Sol's sector mid-fight: holder and every saved share come back as saved.
    const solSaved = saved.find((e) => e.sectorKey === 'sol-prime')!;
    const sol = t2.controlState('sol-prime')!;
    expect(sol.holder).toBe(solSaved.holder);
    expect([...sol.shares].sort()).toEqual(solSaved.shares);
    expect(t2.saveControl()).toEqual(saved);
    t2.stop();
  });

  it('a territory at its seeds saves nothing', () => {
    const { t, run } = build();
    run(60);
    expect(t.saveControl()).toEqual([]);
    t.stop();
  });

  it('an old save without control loads with the seeds', () => {
    const { dp, setRaw } = rowStore();
    setRaw(JSON.stringify({ version: DIRECTOR_STATE_VERSION, savedAtMs: 0, squads: [], waveCount: [], lastDispatchAtMs: [] }));
    const hydrated = dp.hydrate();
    expect(hydrated).not.toBeNull();
    expect(hydrated!.sectorControl).toBeUndefined();
    const { t } = build();
    t.restoreControl(hydrated!.sectorControl ?? []);
    expect(t.sectorOwner('sol-prime')?.factionId).toBe('core');
    expect(t.sectorOwner('bloomgate')?.factionId).toBe('verdant-reach');
    expect(t.sectorOwner('orion-belt')).toBeNull();
    t.stop();
  });

  it('a malformed entry is dropped; the good ones still load', () => {
    const { dp, setRaw } = rowStore();
    setRaw(JSON.stringify({
      version: DIRECTOR_STATE_VERSION, savedAtMs: 0, squads: [], waveCount: [], lastDispatchAtMs: [],
      sectorControl: [
        { sectorKey: 'orion-belt', holder: 'alice', shares: [['alice', 87.5]] },
        { sectorKey: 'sol-prime', holder: 42, shares: [] },
        { sectorKey: 'bloomgate', holder: null, shares: [['x', 'lots']] },
        { sectorKey: 'bloomgate', holder: null, shares: [['x', 250]] },
        'garbage',
        null,
      ],
    }));
    const hydrated = dp.hydrate();
    expect(hydrated!.sectorControl).toEqual([{ sectorKey: 'orion-belt', holder: 'alice', shares: [['alice', 87.5]] }]);
    const { t } = build();
    t.restoreControl(hydrated!.sectorControl!);
    expect(t.sectorOwner('orion-belt')?.factionId).toBe('alice');
    expect(t.sectorOwner('sol-prime')?.factionId).toBe('core');
    expect(t.sectorOwner('bloomgate')?.factionId).toBe('verdant-reach');
    t.stop();
  });

  it('a non-array control field loads as no entries (seeds)', () => {
    const { dp, setRaw } = rowStore();
    setRaw(JSON.stringify({
      version: DIRECTOR_STATE_VERSION, savedAtMs: 0, squads: [], waveCount: [], lastDispatchAtMs: [],
      sectorControl: { nope: true },
    }));
    expect(dp.hydrate()!.sectorControl).toEqual([]);
  });

  it('a saved sector that is not in this galaxy is ignored', () => {
    const { t } = build();
    t.restoreControl([{ sectorKey: 'gone-sector', holder: 'alice', shares: [['alice', 100]] }]);
    expect(t.sectorOwner('gone-sector')).toBeNull();
    expect(t.saveControl()).toEqual([]);
    t.stop();
  });

  it('a saved Ancients share or hold is dropped on restore (they never count for control)', () => {
    const { t } = build();
    t.restoreControl([{ sectorKey: 'bloomgate', holder: 'ancients', shares: [['ancients', 70], ['alice', 30]] }]);
    const s = t.controlState('bloomgate')!;
    expect(s.holder).toBeNull();
    expect([...s.shares.keys()]).toEqual(['alice']);
    t.stop();
  });
});
