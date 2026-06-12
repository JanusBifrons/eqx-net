import { describe, it, expect, beforeEach } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem, resolveTurretBeam } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_COST_PER_HP,
  MINING_BEAM_CADENCE_MS,
} from '../../core/structures/structureGridConstants.js';

/** Shared harness: a real registry + health map, with placement + grid wired
 *  over the same state (the way SectorRoom wires them). */
function makeHarness(
  asteroid?: { entityId: number; x: number; y: number; range?: number; resources?: number },
  drone?: { id: string; entityId: number; x: number; y: number },
) {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const despawned: string[] = [];
  const damage: Array<{ targetId: string; shooterId: string; amount: number }> = [];
  const beams: Array<{ shooterId: string; targetId: string; mountId?: string; fromX: number; fromY: number; toX: number; toY: number }> = [];
  let counter = 0;

  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { despawned.push(id); health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });

  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { despawned.push(id); health.delete(id); },
    findNearestAsteroid: (x, y, range) => {
      if (!asteroid) return null;
      // WS-4: skip exhausted rocks (mirrors SectorRoom.findNearestAsteroid).
      if (asteroid.resources !== undefined && asteroid.resources <= 0) return null;
      if (Math.hypot(asteroid.x - x, asteroid.y - y) > range) return null;
      return { entityId: asteroid.entityId, x: asteroid.x, y: asteroid.y };
    },
    drawAsteroidResources: (entityId, amount) => {
      if (!asteroid || asteroid.entityId !== entityId || asteroid.resources === undefined) return amount;
      const drawn = Math.min(amount, asteroid.resources);
      asteroid.resources -= drawn;
      return drawn;
    },
    findNearestDrone: (x, y, range) => {
      if (!drone) return null;
      if (Math.hypot(drone.x - x, drone.y - y) > range) return null;
      return { id: drone.id, entityId: drone.entityId, x: drone.x, y: drone.y };
    },
    applyDamage: (targetId, shooterId, amount) => damage.push({ targetId, shooterId, amount }),
    broadcastBeam: (shooterId, fromX, fromY, toX, toY, targetId, mountId) =>
      beams.push({ shooterId, targetId, mountId, fromX, fromY, toX, toY }),
  });

  let now = 0;
  const pulse = () => { now += 1000; return grid.pulse(now); };
  return { registry, health, despawned, damage, beams, placement, grid, pulse, asteroid };
}

const OWNER = 'player-1';

/**
 * WS-5 (R2.10) — under capital-only-connectors a leaf can no longer attach
 * DIRECTLY to the Capital; it must route through a Connector relay. This places
 * + force-builds a Connector OFFSET from the Capital (default (0,140), just
 * above it) so the test's leaves auto-connect to IT. The offset is the trick:
 * a connector beside the Capital clears the Capital's line-of-sight, so ONE
 * relay can serve leaves on several sides (their sightlines pass around the
 * Capital, not through it). Call it AFTER placing the Capital and BEFORE the
 * leaves. The relay adds 0 net power, so it never perturbs a test's power math.
 * Use the (x,y) override when leaves sit on the +y/−y axis (offset on X then).
 */
function relayConnector(
  h: ReturnType<typeof makeHarness>,
  x = 0,
  y = 140,
): string {
  const c = h.placement.place(OWNER, 'connector', x, y)!;
  const rec = h.registry.get(c)!;
  rec.isConstructed = true;
  rec.constructionProgress = rec.constructionCost;
  h.health.set(c, getStructureKind('connector').maxHealth);
  h.registry.topologyDirty = true;
  return c;
}

describe('StructureGridSubsystem — batteries (full power buffer)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  /** Force a placed blueprint straight to its built state (skip the slow
   *  construction pulses) + dirty topology so the next pulse relays it. */
  const build = (id: string, kind: string): void => {
    const rec = h.registry.get(id)!;
    rec.isConstructed = true;
    rec.constructionProgress = rec.constructionCost;
    h.health.set(id, getStructureKind(kind).maxHealth);
    h.registry.topologyDirty = true;
  };

  it('charges from a powered grid surplus and caps at capacity', () => {
    h.placement.place(OWNER, 'capital', 0, 0)!; // pre-built, +50 surplus
    relayConnector(h); // WS-5: battery routes to the Capital via a Connector
    const bat = h.placement.place(OWNER, 'battery', 200, 0)!;
    build(bat, 'battery');
    expect(h.registry.get(bat)!.storedPower).toBe(0);

    const capacity = getStructureKind('battery').powerStorageCapacity!; // 300
    for (let i = 0; i < 6; i++) h.pulse(); // +50/pulse → 300 by pulse 6
    expect(h.registry.get(bat)!.storedPower).toBe(capacity);
    h.pulse(); // full → no overflow
    expect(h.registry.get(bat)!.storedPower).toBe(capacity);
  });

  it('discharges to keep a deficit grid powered, then browns out when empty', () => {
    h.placement.place(OWNER, 'capital', 0, 0)!; // +50
    relayConnector(h); // WS-5: battery + miner route via this Connector (offset +y clears the Capital LOS to both ±x leaves)
    const bat = h.placement.place(OWNER, 'battery', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', -200, 0)!; // -60 once built
    build(bat, 'battery');
    // Charge while the miner is still a blueprint (contributes 0): +50/pulse.
    for (let i = 0; i < 6; i++) h.pulse();
    expect(h.registry.get(bat)!.storedPower).toBe(300);

    // Bring the miner online → component balance 50 - 60 = -10/pulse.
    build(miner, 'miner');
    h.pulse();
    // Battery covers the shortfall → miner stays powered despite a negative net.
    expect(h.grid.powerSummaryFor(miner).netPower).toBe(-10);
    expect(h.grid.powerSummaryFor(miner).powered).toBe(true);
    expect(h.registry.get(bat)!.storedPower).toBe(290); // 300 - 10

    // 29 more pulses drain the remaining 290 at 10/pulse → empty.
    for (let i = 0; i < 29; i++) h.pulse();
    expect(h.registry.get(bat)!.storedPower).toBe(0);
    // No charge left + a -10 balance → the whole component browns out.
    h.pulse();
    expect(h.grid.powerSummaryFor(miner).powered).toBe(false);
  });

  it('a battery with no capital path stays inert (capital-less island)', () => {
    // Battery + solar far from any capital → unpowered island, no charge.
    const sol = h.placement.place(OWNER, 'solar', 4000, 0)!;
    const bat = h.placement.place(OWNER, 'battery', 4120, 0)!;
    build(sol, 'solar');
    build(bat, 'battery');
    for (let i = 0; i < 5; i++) h.pulse();
    expect(h.registry.get(bat)!.storedPower).toBe(0);
  });
});

describe('StructureGridSubsystem — auto-connect on place', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a connector placed in range of the capital auto-links to it', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    expect(h.registry.hasConnection(cap, con)).toBe(true);
    expect(h.registry.connectionCount(con)).toBe(1);
  });

  it('a leaf placed near another leaf (no hub in range) stays unconnected', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    expect(cap).toBeTruthy();
    // Two solars far from the capital but near each other → hub rule blocks them.
    const s1 = h.placement.place(OWNER, 'solar', 3000, 0)!;
    const s2 = h.placement.place(OWNER, 'solar', 3120, 0)!;
    expect(h.registry.connectionCount(s1)).toBe(0);
    expect(h.registry.connectionCount(s2)).toBe(0);
  });

  it('does not connect structures owned by different players', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place('player-2', 'connector', 200, 0)!;
    expect(h.registry.hasConnection(cap, con)).toBe(false);
  });
});

describe('StructureGridSubsystem — reconnect sweep (playtest 2026-06-10 Issue 2)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a Connector placed near pre-existing leaves multi-connects to ALL of them at placement (WS-5 R2.17)', () => {
    // Three solars placed first, no hub yet → all auto-connect-on-place to nothing.
    const s1 = h.placement.place(OWNER, 'solar', 250, 0)!;
    const s2 = h.placement.place(OWNER, 'solar', 0, 250)!;
    const s3 = h.placement.place(OWNER, 'solar', -250, 0)!;
    expect(h.registry.connectionCount(s1)).toBe(0);
    expect(h.registry.connectionCount(s2)).toBe(0);
    expect(h.registry.connectionCount(s3)).toBe(0);

    // Place the Capital, then a Connector hub (offset above the Capital so it
    // sees the Capital AND all 3 solars). WS-5 R2.17 multi-connect: the
    // Connector's placement-connect grabs EVERY in-range legal partner at once —
    // the Capital (Connector↔Capital is legal) plus all 3 solars (Connector↔leaf)
    // — up to its cap of 6. (Pre-R2.17 nearest-only grabbed JUST the Capital and
    // the solars waited for the 1 Hz reconnect sweep; multi-connect wires them
    // immediately, which is the more direct fix for the 2026-06-10 Issue-2
    // "I placed a relay near my panels but they don't light up" complaint.)
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 0, 140)!;
    expect(h.registry.hasConnection(con, cap), 'connector links to the capital').toBe(true);
    expect(h.registry.hasConnection(s1, con)).toBe(true);
    expect(h.registry.hasConnection(s2, con)).toBe(true);
    expect(h.registry.hasConnection(s3, con)).toBe(true);
    expect(h.registry.connectionCount(con)).toBe(4); // capital + 3 solars, within cap 6

    // The reconnect sweep is now a no-op for this scene (everything wired at
    // placement) — it must not double-link or sever.
    h.pulse();
    expect(h.registry.connectionCount(con)).toBe(4);
    expect(h.registry.hasConnection(s1, con)).toBe(true);
    expect(h.registry.hasConnection(s2, con)).toBe(true);
    expect(h.registry.hasConnection(s3, con)).toBe(true);
  });

  it('a leaf stranded by a hub AT CAPACITY connects once a slot frees', () => {
    // WS-5: leaves attach to Connectors, not the Capital. The capacity-limited
    // hub here is a Connector (maxConnections 6); it spends one slot on the
    // Capital, leaving 5 for leaves, so a 6th leaf in range is stranded until a
    // slot frees. The solars sit in an arc ABOVE the Capital so each has clear
    // line-of-sight to the relay.
    h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = relayConnector(h); // links to the capital (1 slot used)
    // Fan the leaves at DISTINCT angles around the relay (all in the upper arc,
    // clear of the Capital below it). Radial sightlines from one hub never cross,
    // so no leaf blocks another's line-of-sight to the relay — and the stranded
    // one (at 0°, due +x) stays reachable when a slot frees.
    const fillers = [
      h.placement.place(OWNER, 'solar', 307, 363)!, // 36°
      h.placement.place(OWNER, 'solar', 117, 501)!, // 72°
      h.placement.place(OWNER, 'solar', -117, 501)!, // 108°
      h.placement.place(OWNER, 'solar', -307, 363)!, // 144°
      h.placement.place(OWNER, 'solar', -380, 140)!, // 180°
    ];
    expect(h.registry.connectionCount(con)).toBe(6); // capital + 5 solars = full
    const stranded = h.placement.place(OWNER, 'solar', 380, 140)!; // 0°, clear lane
    h.pulse();
    expect(h.registry.connectionCount(stranded)).toBe(0); // hub at capacity

    // Remove one filler → a slot frees → the next pulse reconnects the stranded leaf.
    h.placement.remove(OWNER, fillers[0]!);
    h.pulse();
    expect(h.registry.hasConnection(stranded, con)).toBe(true);
  });

  it('the reconnect sweep is bounded — at most MAX_RECONNECT_ATTEMPTS_PER_PULSE retries per pulse', () => {
    // Many permanently-stranded leaves (no hub at all) must not be expensive:
    // the sweep caps attempts, so it never connects spuriously and never throws.
    for (let i = 0; i < 20; i++) h.placement.place(OWNER, 'solar', i * 200, 5000);
    expect(() => h.pulse()).not.toThrow();
    for (const rec of h.registry.all()) expect(h.registry.connectionCount(rec.id)).toBe(0);
  });
});

describe('StructureGridSubsystem — construction flow economy', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a connector blueprint builds up pulse-by-pulse, debiting the capital', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const cost = getStructureKind('connector').constructionCost;
    const capRec = h.registry.get(cap)!;
    const conRec = h.registry.get(con)!;
    const startMinerals = capRec.minerals;
    expect(conRec.isConstructed).toBe(false);

    h.pulse();
    expect(conRec.constructionProgress).toBe(CONSTRUCTION_PULSE_AMOUNT);
    expect(capRec.minerals).toBe(startMinerals - CONSTRUCTION_PULSE_AMOUNT);

    // Drive to completion.
    const pulsesNeeded = Math.ceil(cost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 1; i < pulsesNeeded; i++) h.pulse();
    expect(conRec.isConstructed).toBe(true);
    expect(conRec.constructionProgress).toBe(cost);
    // HP reset to full on completion.
    expect(h.health.get(con)).toBe(getStructureKind('connector').maxHealth);
  });

  it('construction PAUSES when the capital runs dry and RESUMES on refill', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const capRec = h.registry.get(cap)!;
    const conRec = h.registry.get(con)!;

    h.pulse();
    const progressAfterOne = conRec.constructionProgress;
    expect(progressAfterOne).toBeGreaterThan(0);

    // Empty the bank → construction stalls (no progress, no negative minerals).
    capRec.minerals = 0;
    h.pulse();
    h.pulse();
    expect(conRec.constructionProgress).toBe(progressAfterOne);
    expect(capRec.minerals).toBe(0);

    // Refill → resumes exactly where it paused (no progress lost).
    capRec.minerals = 1000;
    h.pulse();
    expect(conRec.constructionProgress).toBe(progressAfterOne + CONSTRUCTION_PULSE_AMOUNT);
  });

  it('dead-end: a leaf behind an UNBUILT connector receives nothing until it completes', () => {
    h.placement.place(OWNER, 'capital', 0, 0);
    const con = h.placement.place(OWNER, 'connector', 300, 0)!;
    const sol = h.placement.place(OWNER, 'solar', 600, 0)!;
    const conRec = h.registry.get(con)!;
    const solRec = h.registry.get(sol)!;
    // Solar should hang off the connector (nearest hub), not the capital.
    expect(h.registry.hasConnection(sol, con)).toBe(true);

    // While the connector is a blueprint, the solar gets zero (can't relay
    // through a half-built node).
    const conCost = getStructureKind('connector').constructionCost;
    const pulsesToBuildCon = Math.ceil(conCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulsesToBuildCon; i++) {
      h.pulse();
      if (!conRec.isConstructed) expect(solRec.constructionProgress).toBe(0);
    }
    expect(conRec.isConstructed).toBe(true);
    expect(solRec.constructionProgress).toBe(0); // still 0 the pulse it completes

    // Now the connector relays → the solar starts building.
    h.pulse();
    expect(solRec.constructionProgress).toBeGreaterThan(0);
  });
});

describe('StructureGridSubsystem — repair + deconstruction', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a damaged BUILT structure repairs over pulses, debiting minerals', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const conRec = h.registry.get(con)!;
    const capRec = h.registry.get(cap)!;
    // Fast-build the connector.
    const pulses = Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulses; i++) h.pulse();
    expect(conRec.isConstructed).toBe(true);

    // Damage it, then repair.
    h.health.set(con, 50);
    const mineralsBefore = capRec.minerals;
    h.pulse();
    const expectedGain = REPAIR_PULSE_AMOUNT / REPAIR_COST_PER_HP; // 30 HP
    expect(h.health.get(con)).toBeCloseTo(50 + expectedGain, 5);
    expect(capRec.minerals).toBeCloseTo(mineralsBefore - REPAIR_PULSE_AMOUNT, 5);
  });

  it('deconstruction drains progress, returns minerals, and removes the structure', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const conRec = h.registry.get(con)!;
    const capRec = h.registry.get(cap)!;
    const pulses = Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulses; i++) h.pulse();
    const mineralsBefore = capRec.minerals;

    conRec.isDeconstructing = true;
    h.pulse(); // DECONSTRUCTION_RATE_KG (100) ≥ connector cost (80) → one pulse
    expect(h.registry.has(con)).toBe(false);
    expect(h.despawned).toContain(con);
    expect(capRec.minerals).toBeGreaterThan(mineralsBefore); // reclaimed
  });
});

describe('StructureGridSubsystem — mining (Phase 4)', () => {
  it('a built + powered miner extracts minerals and hauls them to the capital', async () => {
    // Asteroid at (250,0), within the miner's miningRange.
    const h = makeHarness({ entityId: 7, x: 250, y: 0 });
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: solar + miner route to the Capital via a Connector
    // Solar to offset the miner's power draw (miner consumes 60; cap 50 + solar 30 = 80).
    const sol = h.placement.place(OWNER, 'solar', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    const capRec = [...h.registry.all()].find((r) => r.kind === 'capital')!;

    // Build solar + miner.
    for (let i = 0; i < 200; i++) h.pulse();
    expect(h.registry.get(sol)!.isConstructed).toBe(true);
    expect(h.registry.get(miner)!.isConstructed).toBe(true);

    const before = capRec.minerals;
    h.pulse();
    // The miner mined + hauled this pulse → capital bank grew.
    expect(capRec.minerals).toBeGreaterThan(before);
    expect(h.registry.get(miner)!.miningTargetEntityId).toBe(7);
  });

  it('an UNPOWERED miner does not mine (no asteroid target set)', () => {
    // Asteroid in range, but no solar → miner draws the grid negative.
    const h = makeHarness({ entityId: 9, x: 250, y: 0 });
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: miner routes to the Capital via a Connector (still draws the grid negative → unpowered)
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    // Build the miner (construction itself isn't power-gated).
    for (let i = 0; i < 400; i++) h.pulse();
    const minerRec = h.registry.get(miner)!;
    expect(minerRec.isConstructed).toBe(true);
    // Capital 50 − miner 60 = −10 → unpowered → no mining target, no minerals.
    h.pulse();
    expect(minerRec.miningTargetEntityId).toBeUndefined();
    expect(minerRec.minerals).toBe(0);
  });

  it('WS-4/R2.27 Phase 1: draws down a FINITE asteroid pool, then stops + clears the target on exhaustion', () => {
    const RATE = getStructureKind('miner').miningRate ?? 0;
    expect(RATE).toBeGreaterThan(0);
    const POOL = 2 * RATE; // exactly two pulses' worth of ore
    // Asteroid in range with a finite pool; capital(+50)+solar(+30)−miner(60) = +20 → powered.
    const h = makeHarness({ entityId: 7, x: 250, y: 0, resources: POOL });
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: solar + miner route to the Capital via a Connector
    const sol = h.placement.place(OWNER, 'solar', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    // Force solar + miner BUILT (skip the slow construction pulses) so mining
    // starts on a known pulse — otherwise the build-loop tail would mine the
    // small pool before we can observe the draw-down.
    for (const [id, kind] of [[sol, 'solar'], [miner, 'miner']] as const) {
      const r = h.registry.get(id)!;
      r.isConstructed = true;
      r.constructionProgress = r.constructionCost;
      h.health.set(id, getStructureKind(kind).maxHealth);
    }
    h.registry.topologyDirty = true;
    const minerRec = h.registry.get(miner)!;

    // Pulse 1: mine one RATE → pool drops by RATE, target still the rock.
    h.pulse();
    expect(h.asteroid!.resources).toBe(POOL - RATE);
    expect(minerRec.miningTargetEntityId).toBe(7);
    // Pulse 2: mine the last RATE → pool exhausted (0).
    h.pulse();
    expect(h.asteroid!.resources).toBe(0);
    // Pulse 3: the exhausted rock is skipped by findNearestAsteroid → the miner
    // clears its target (the beam will stop). RED on current code: processMining
    // adds a flat miningRate forever with no resource read, so the pool never
    // depletes and miningTargetEntityId stays pinned to 7.
    h.pulse();
    expect(minerRec.miningTargetEntityId).toBeUndefined();
  });

  it('WS-4/R2.27 Phase 2: a built+powered miner broadcasts a mining beam (mountId drill) on the cadence; targetless does NOT', () => {
    const h = makeHarness({ entityId: 7, x: 250, y: 0, resources: 1_000_000 }); // plenty of ore
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: solar + miner route to the Capital via a Connector
    const sol = h.placement.place(OWNER, 'solar', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    // Force solar + miner built (capital+50 + solar+30 − miner 60 = +20 → powered).
    for (const [id, kind] of [[sol, 'solar'], [miner, 'miner']] as const) {
      const r = h.registry.get(id)!;
      r.isConstructed = true;
      r.constructionProgress = r.constructionCost;
      h.health.set(id, getStructureKind(kind).maxHealth);
    }
    h.registry.topologyDirty = true;
    // A grid pulse sets the miner's target + cached pose (processMining).
    h.pulse();
    expect(h.registry.get(miner)!.miningTargetEntityId).toBe(7);

    // tickMiners broadcasts the mining beam from the miner to the asteroid.
    // RED on current code: tickMiners + the mining beam don't exist (mining is
    // silent — only the turret ever broadcasts a beam).
    h.grid.tickMiners(10_000);
    expect(h.beams.length).toBe(1);
    expect(h.beams[0]!.shooterId).toBe(miner);
    expect(h.beams[0]!.mountId).toBe('drill');
    expect(h.beams[0]!.targetId).toBe('swarm-7'); // asteroid wire id

    // Cadence gate: an immediate re-tick within MINING_BEAM_CADENCE_MS is suppressed.
    h.grid.tickMiners(10_050);
    expect(h.beams.length).toBe(1);
    // …then it broadcasts again once the cadence elapses (continuous beam).
    h.grid.tickMiners(10_000 + MINING_BEAM_CADENCE_MS + 1);
    expect(h.beams.length).toBe(2);

    // A miner with no target broadcasts nothing.
    const mr = h.registry.get(miner)!;
    mr.miningTargetEntityId = undefined;
    mr.miningTargetX = undefined;
    mr.miningTargetY = undefined;
    const before = h.beams.length;
    h.grid.tickMiners(20_000);
    expect(h.beams.length).toBe(before);
  });

  it('WS-4/R2.27 Phase 2: the mining-beam endpoint is the CACHED rock pose — it does NOT re-scan the live asteroid (beam stays pinned as rocks drift)', () => {
    const h = makeHarness({ entityId: 7, x: 250, y: 0, resources: 1_000_000 });
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: solar + miner route to the Capital via a Connector
    const sol = h.placement.place(OWNER, 'solar', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    for (const [id, kind] of [[sol, 'solar'], [miner, 'miner']] as const) {
      const r = h.registry.get(id)!;
      r.isConstructed = true;
      r.constructionProgress = r.constructionCost;
      h.health.set(id, getStructureKind(kind).maxHealth);
    }
    h.registry.topologyDirty = true;

    // A grid pulse caches the rock's pose (250, 0) onto the miner.
    h.pulse();
    h.grid.tickMiners(10_000);
    expect(h.beams.length).toBe(1);
    expect(h.beams[0]!.toX).toBe(250);
    expect(h.beams[0]!.toY).toBe(0);
    expect(h.beams[0]!.targetId).toBe('swarm-7');

    // The asteroid's LIVE pose moves, but NO new grid pulse refreshes the cache.
    // tickMiners must keep broadcasting the CACHED endpoint (250, 0) — it must
    // NOT re-scan the live asteroid. A live re-lookup would make the beam jitter
    // as rocks drift (and here would even find the rock out of range). This is
    // the regression lock for the cached-pose design (guards a future switch
    // from the cached fields back to a per-tick findNearestAsteroid).
    h.asteroid!.x = 999;
    h.asteroid!.y = 999;
    h.grid.tickMiners(10_000 + MINING_BEAM_CADENCE_MS + 1);
    expect(h.beams.length).toBe(2);
    expect(h.beams[1]!.toX).toBe(250); // still the cached pose, NOT 999
    expect(h.beams[1]!.toY).toBe(0);
    expect(h.beams[1]!.targetId).toBe('swarm-7'); // cached wire id, not rebuilt
  });
});

describe('resolveTurretBeam — continuous beam model (playtest 2026-06-10 Issue 5)', () => {
  it('fires on the beam cooldown with DPS-preserving small per-hit damage', () => {
    // Turret: weaponDamage 20 / fireRateMs 600 = 33.3 DPS. Beam cooldown 10
    // ticks @ 60 Hz = 167 ms (6 Hz, same as a player beam).
    const { cooldownMs, perHitDamage } = resolveTurretBeam(20, 600, 10);
    expect(cooldownMs).toBeCloseTo(166.67, 1);
    // Small steady hit, NOT the old 20-damage lump.
    expect(perHitDamage).toBeLessThan(20);
    // Total DPS preserved: perHit / cooldownSec ≈ 33.3.
    expect(perHitDamage / (cooldownMs / 1000)).toBeCloseTo(33.33, 1);
  });

  it('a zero fireRateMs yields zero damage (no divide-by-zero)', () => {
    expect(resolveTurretBeam(20, 0, 10).perHitDamage).toBe(0);
  });
});

describe('StructureGridSubsystem — turrets (Phase 5)', () => {
  it('a built + powered turret fires the beam model — a stream of small hits, not one 600 ms pulse', () => {
    const drone = { id: 'swarm-3', entityId: 3, x: 200, y: 0 };
    const h = makeHarness(undefined, drone);
    h.placement.place(OWNER, 'capital', 0, 0);
    // Diagonal offset (120,120) so the relay clears the Capital's LOS to BOTH
    // the close +x solar (150,0) and the +y turret (0,200).
    relayConnector(h, 120, 120);
    const sol = h.placement.place(OWNER, 'solar', 150, 0)!; // offsets turret draw (15)
    const turret = h.placement.place(OWNER, 'turret', 0, 200)!;
    for (let i = 0; i < 120; i++) h.pulse();
    expect(h.registry.get(sol)!.isConstructed).toBe(true);
    expect(h.registry.get(turret)!.isConstructed).toBe(true);

    const kind = getStructureKind('turret');
    const beam = resolveTurretBeam(kind.weaponDamage!, kind.fireRateMs!, getWeapon('hitscan').cooldownTicks);

    // First tick fires; an immediate second tick is on the BEAM cooldown
    // (~167 ms), not the old 600 ms pulse.
    h.grid.tickTurrets(10_000);
    h.grid.tickTurrets(10_050);
    expect(h.damage.length).toBe(1);
    expect(h.damage[0]!.targetId).toBe('swarm-3');
    expect(h.damage[0]!.shooterId).toBe(turret);
    // Small per-hit damage (continuous DoT), NOT the old 20-lump.
    expect(h.damage[0]!.amount).toBeCloseTo(beam.perHitDamage, 3);
    expect(h.damage[0]!.amount).toBeLessThan(20);
    expect(h.beams.length).toBe(1);
    expect(h.registry.get(turret)!.turretTargetEntityId).toBe(3);

    // After the beam cooldown elapses it fires again (steady stream).
    h.grid.tickTurrets(10_000 + beam.cooldownMs + 1);
    expect(h.damage.length).toBe(2);

    // DPS preserved: over a ~600 ms window the turret lands ~today's 33.3 DPS
    // worth, just spread across multiple small hits instead of one lump.
    const totalOver600 = h.damage.reduce((s, d) => s + d.amount, 0);
    expect(totalOver600).toBeCloseTo(2 * beam.perHitDamage, 3);
  });

  it('an UNPOWERED turret does not fire', () => {
    const drone = { id: 'swarm-4', entityId: 4, x: 200, y: 0 };
    const h = makeHarness(undefined, drone);
    h.placement.place(OWNER, 'capital', 0, 0);
    // WS-5: turret + miner route via a Connector offset on +x (so it clears the
    // Capital's LOS to both the +y turret and the −y miner).
    relayConnector(h, 140, 0);
    const turret = h.placement.place(OWNER, 'turret', 0, 200)!;
    // No solar: but turret only draws 15; capital 50 − 15 = 35 ≥ 0 → powered.
    // Add a heavy consumer to push the grid negative.
    const m1 = h.placement.place(OWNER, 'miner', 0, -200)!; // consumes 60
    for (let i = 0; i < 400; i++) h.pulse();
    expect(h.registry.get(turret)!.isConstructed).toBe(true);
    expect(h.registry.get(m1)!.isConstructed).toBe(true);
    // capital 50 − turret 15 − miner 60 = −25 → unpowered.
    h.grid.tickTurrets(10_000);
    expect(h.damage.length).toBe(0);
    expect(h.registry.get(turret)!.turretTargetEntityId).toBeUndefined();
  });

  it('a turret with no drone in range fires nothing', () => {
    const h = makeHarness(); // no drone
    h.placement.place(OWNER, 'capital', 0, 0);
    relayConnector(h); // WS-5: turret routes to the Capital via a Connector
    const turret = h.placement.place(OWNER, 'turret', 0, 200)!;
    for (let i = 0; i < 120; i++) h.pulse();
    expect(h.registry.get(turret)!.isConstructed).toBe(true);
    h.grid.tickTurrets(10_000);
    expect(h.damage.length).toBe(0);
  });
});

describe('StructureGridSubsystem — power summary', () => {
  it('a built capital→connector→solar web reports powered + summed netPower', () => {
    const h = makeHarness();
    h.placement.place(OWNER, 'capital', 0, 0);
    const con = h.placement.place(OWNER, 'connector', 300, 0)!;
    const sol = h.placement.place(OWNER, 'solar', 600, 0)!;
    // Build connector then solar (drive enough pulses for both).
    for (let i = 0; i < 60; i++) h.pulse();
    expect(h.registry.get(con)!.isConstructed).toBe(true);
    expect(h.registry.get(sol)!.isConstructed).toBe(true);
    // pulse once more so the final topology rebuild ran.
    h.pulse();
    const summary = h.grid.powerSummaryFor(sol);
    expect(summary.powered).toBe(true);
    expect(summary.netPower).toBe(80); // capital 50 + solar 30
  });
});
