/**
 * Flagship fleets (wrap-up W2a): the director against fake rooms. Spawns a
 * named capital with escorts at a gate pocket, moves the whole fleet by warp,
 * breaks the fleet when the flagship dies, and resumes from persisted state.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { escortRing, FlagshipDirector, FLEET_ESCORT_KINDS, fleetCapitalKind, styledKind } from './FlagshipDirector.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import { sectorSites } from '../../core/galaxy/sectorSites.js';
import { sectorController } from '../../core/galaxy/control.js';
import { GALAXY_SECTORS, getNeighbours } from '../../core/galaxy/galaxy.js';

interface Bot { kind: string; x: number; y: number; elite?: string }

function fakeRoom() {
  const bus = new EventEmitter();
  const bots = new Map<string, Bot>();
  const warps: Array<{ id: string; x: number; y: number }> = [];
  const stations = new Map<string, { x: number; y: number }>();
  const guards = new Map<string, { x: number; y: number; r: number }>();
  const room = {
    bots, warps, stations, guards, bus,
    eventBus: () => bus,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: (s: { botId: string; kind: string; x: number; y: number }) => { bots.set(s.botId, { kind: s.kind, x: s.x, y: s.y }); return true; },
    despawnLivingWorldBot: (id: string) => { const b = bots.get(id); bots.delete(id); return b ? { kind: b.kind, health: 1 } : null; },
    markElite: (id: string, name: string) => { const b = bots.get(id); if (!b) return false; b.elite = name; return true; },
    setBotFlockFollow: () => {},
    setBotFlockLeaderCourse: () => {},
    setBotMoveTarget: (id: string, x: number, y: number) => { stations.set(id, { x, y }); },
    setBotGuardPost: (id: string, x: number, y: number, r: number) => { guards.set(id, { x, y, r }); },
    getBotPose: (id: string) => { const b = bots.get(id); return b ? { x: b.x, y: b.y, angle: 0 } : null; },
    warpBot: (id: string, x: number, y: number) => { warps.push({ id, x, y }); const b = bots.get(id); if (b) { b.x = x; b.y = y; } return true; },
    botWarpPhase: () => 0 as const,
    broadcastWorldNotice: () => {},
  };
  return room;
}
type FakeRoom = ReturnType<typeof fakeRoom>;

const A = 'sol-prime';
function director(rooms: Map<string, FakeRoom>, extra: Partial<ConstructorParameters<typeof FlagshipDirector>[1]> = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => { t += ms; } };
  const d = new FlagshipDirector(rooms as unknown as Map<string, LivingWorldRoom>, { rng: () => 0.3, nowMs: () => t, firstSector: A, dwellMs: 1000, respawnMs: 5000, ...extra });
  return { d, clock, now: () => t };
}

describe('FlagshipDirector', () => {
  it('spawns a named capital at a gate pocket, its escorts on stations clear of its hull', () => {
    const room = fakeRoom();
    const { d } = director(new Map([[A, room]]));
    d.start();
    const [f] = d.fleetsView();
    expect(f?.sectorKey).toBe(A);
    expect(f?.escorts).toBe(FLEET_ESCORT_KINDS.length);
    const lead = [...room.bots.entries()].find(([id]) => id.endsWith('-lead'))!;
    expect(lead[1].elite).toBe(f!.name);
    expect(lead[0].startsWith('flagship-')).toBe(true);
    // On a gate pocket's rim.
    const gate = sectorSites(A).filter((s) => s.kind === 'gate').find((s) => Math.abs(Math.hypot(lead[1].x - s.x, lead[1].y - s.y) - s.r) < 1);
    expect(gate).toBeDefined();
    for (const [id, b] of room.bots) {
      if (id.endsWith('-lead')) continue;
      const st = room.stations.get(id)!;
      const ring = escortRing(lead[1].kind as ShipKindId, b.kind as ShipKindId);
      expect(Math.hypot(st.x - lead[1].x, st.y - lead[1].y)).toBeCloseTo(ring, 0);
      expect(ring).toBeGreaterThan(1000); // clear of a capital, not a fighter's flock distance
    }
    expect(d.sectorCapital(A)?.name).toBe(f!.name);
    expect(d.sectorCapital('vega-reach')).toBeNull();
  });

  it('posts the whole fleet on the pocket it holds, and moves the post when it warps', () => {
    // Owner 2026-11-11: a defender "should stay close to the thing it's
    // defending" — the fleet's capitals fight from their pocket.
    const room = fakeRoom();
    const { d, clock, now } = director(new Map([[A, room]]));
    d.start();
    clock.advance(100);
    d.tick(now());
    const pocket = (): string => d.state().fleets[0]!.pocketId;
    const expectPosted = (siteId: string): void => {
      const site = sectorSites(A).find((s) => s.id === siteId)!;
      expect(room.guards.size).toBe(1 + FLEET_ESCORT_KINDS.length);
      for (const id of room.bots.keys()) expect(room.guards.get(id), id).toEqual({ x: site.x, y: site.y, r: site.r });
    };
    const first = pocket();
    expectPosted(first);
    clock.advance(2000);
    d.tick(now());
    clock.advance(1500);
    d.tick(now());
    expect(pocket()).not.toBe(first);
    expectPosted(pocket());
  });

  it('moves the whole fleet by warp to another pocket after its dwell', () => {
    const room = fakeRoom();
    const { d, clock, now } = director(new Map([[A, room]]));
    d.start();
    clock.advance(2000);
    d.tick(now());
    // The flagship goes first (it must turn to face the jump; capitals turn slowly).
    expect(new Set(room.warps.map((w) => w.id))).toEqual(new Set(['flagship-0-lead']));
    // Once it faces the jump (this fake has no spool), the escorts follow.
    clock.advance(1500);
    d.tick(now());
    const ids = new Set(room.warps.map((w) => w.id));
    expect(ids.size).toBe(1 + FLEET_ESCORT_KINDS.length); // flagship + every escort
    const lead = room.warps.find((w) => w.id.endsWith('-lead'))!;
    // Dropped on some non-gate pocket's rim.
    const site = sectorSites(A).find((s) => s.kind !== 'gate' && Math.abs(Math.hypot(lead.x - s.x, lead.y - s.y) - s.r) < 2);
    expect(site).toBeDefined();
  });

  it('every third move it crosses into a neighbouring system, arriving at the gate facing back', () => {
    const B = getNeighbours(A)[0]!.key;
    const ra = fakeRoom(), rb = fakeRoom();
    const { d, clock, now } = director(new Map([[A, ra], [B, rb]]), { rng: () => 0 });
    d.start();
    for (let i = 0; i < 12 && d.fleetsView()[0]?.sectorKey === A; i++) { clock.advance(30_000); d.tick(now()); }
    const [f] = d.fleetsView();
    expect(f?.sectorKey).toBe(B);
    expect(ra.bots.size).toBe(0); // left A entirely
    const lead = [...rb.bots.entries()].find(([id]) => id.endsWith('-lead'))![1];
    const gate = sectorSites(B).find((x) => x.id === `gate:${A}`)!;
    expect(Math.abs(Math.hypot(lead.x - gate.x, lead.y - gate.y) - gate.r)).toBeLessThan(1);
    expect(rb.bots.size).toBe(1 + FLEET_ESCORT_KINDS.length);
  });

  it('breaks the fleet when the flagship dies, then a new one arrives later', () => {
    const room = fakeRoom();
    const { d, clock, now } = director(new Map([[A, room]]));
    d.start();
    const leadId = [...room.bots.keys()].find((id) => id.endsWith('-lead'))!;
    room.bots.delete(leadId);
    room.bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: leadId });
    expect(d.fleetsView()).toHaveLength(0);
    expect(room.bots.size).toBe(0); // escorts jumped out
    clock.advance(6000);
    d.tick(now());
    expect(d.fleetsView()).toHaveLength(1);
    expect([...room.bots.keys()].some((id) => id.endsWith('-lead') && id !== leadId)).toBe(true);
  });

  it('resumes a persisted fleet where it was (same name, class and pocket)', () => {
    const room = fakeRoom();
    const first = director(new Map([[A, room]]));
    first.d.start();
    first.clock.advance(2000);
    first.d.tick(first.now()); // moved to another pocket
    const saved = first.d.state();
    expect(saved.fleets).toHaveLength(1);
    const room2 = fakeRoom();
    const second = director(new Map([[A, room2]]), { restore: saved, firstSector: undefined });
    second.d.start();
    const [f] = second.d.fleetsView();
    expect(f?.name).toBe(saved.fleets[0]!.name);
    expect(f?.kind).toBe(saved.fleets[0]!.kind);
    const pocket = sectorSites(A).find((s) => s.id === saved.fleets[0]!.pocketId)!;
    const lead = [...room2.bots.entries()].find(([id]) => id.endsWith('-lead'))![1];
    expect(Math.hypot(lead.x - pocket.x, lead.y - pocket.y)).toBeLessThan(pocket.r + 1);
  });

  it('fields battleships in a power\'s heartland and cruisers on neutral ground', () => {
    const held = GALAXY_SECTORS.find((s) => sectorController(s.key) !== null)!.key;
    const neutral = GALAXY_SECTORS.find((s) => sectorController(s.key) === null)!.key;
    for (const r of [0, 0.6, 0.99]) {
      expect(['battleship', 'battlecruiser']).toContain(fleetCapitalKind(held, () => r));
      expect(['light-cruiser', 'heavy-cruiser']).toContain(fleetCapitalKind(neutral, () => r));
    }
  });
});

describe('styledKind (W2b: a hull style per ship)', () => {
  it('keeps a ship its style, varies it across ships, and leaves non-capitals alone', () => {
    expect(styledKind('battleship', 'flagship-3-lead')).toBe(styledKind('battleship', 'flagship-3-lead'));
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(styledKind('battleship', `flagship-${i}-lead`));
    expect([...seen].sort()).toEqual(['battleship', 'battleship-b', 'battleship-c']);
    expect(styledKind('gunship', 'flagship-1-e3')).toBe('gunship');
  });
});
