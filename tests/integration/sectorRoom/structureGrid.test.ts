/**
 * Structures plan, Phase 3 — the power grid + connector web, through the real
 * SectorRoom (the "new visible entity ⇒ integration test through the full path"
 * mandate). Drives placement over the wire, then advances the grid pulse
 * deterministically via `_internals.pulseStructureGrid()` (no wall-clock wait),
 * and asserts the `structures[]` snapshot slice the client renders from.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

type StructuresSlice = NonNullable<SnapshotMessage['structures']>;

async function placeAndWait(
  harness: SectorTestHarness,
  room: Awaited<ReturnType<SectorTestHarness['connectAs']>>,
  kind: string,
  x: number,
  y: number,
): Promise<string> {
  const internals = harness.getServerRoom()!._internals;
  const before = new Set<string>();
  for (const r of internals.structureRegistry.all()) before.add(r.id);
  room.send('place_structure', { type: 'place_structure', kind, x, y });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const r of internals.structureRegistry.all()) {
      if (!before.has(r.id)) return r.id;
    }
    await harness.advance(40);
  }
  throw new Error(`structure ${kind} never placed`);
}

function sliceEntry(slice: StructuresSlice | undefined, entityId: number): StructuresSlice[number] | undefined {
  return slice?.find((s) => s.id === entityId);
}

/** Resolve a structure's dense entityId (the slice key) from its string id. */
function eid(harness: SectorTestHarness, structureId: string): number {
  return harness.getServerRoom()!._internals.swarmRegistry.get(structureId)!.entityId;
}

describe('SectorRoom integration — structure grid (Phase 3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('capital → connector → solar form a powered web (connTo + positive netPower)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const sol = await placeAndWait(harness, room, 'solar', 600, 0);
    const [capE, conE, solE] = [eid(harness, cap), eid(harness, con), eid(harness, sol)];

    // The web forms on placement (connTo present immediately), even as blueprints.
    let slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, conE)?.connTo).toContain(capE);
    expect(sliceEntry(slice, solE)?.connTo).toContain(conE);

    // Drive construction to completion (connector then solar).
    for (let i = 0; i < 60; i++) internals.pulseStructureGrid();

    slice = internals.getStructuresSlice();
    const solEntry = sliceEntry(slice, solE)!;
    expect(solEntry.built).toBe(true);
    expect(solEntry.powered).toBe(true);
    expect(solEntry.netPower).toBe(80); // capital 50 + solar 30
    // buildPct omitted once complete.
    expect(solEntry.buildPct).toBeUndefined();
  }, 20_000);

  it('a leaf with no hub in range is unconnected + unpowered (leaf↔leaf rejected)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    await placeAndWait(harness, room, 'capital', 0, 0);
    // Two solars far from the capital but near each other.
    const s1 = await placeAndWait(harness, room, 'solar', 3000, 0);
    const s2 = await placeAndWait(harness, room, 'solar', 3120, 0);
    const [s1E, s2E] = [eid(harness, s1), eid(harness, s2)];
    for (let i = 0; i < 5; i++) internals.pulseStructureGrid();

    const slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, s1E)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, s2E)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, s1E)?.powered).toBe(false);
    expect(sliceEntry(slice, s2E)?.powered).toBe(false);
  }, 20_000);

  it('destroying the connector severs a SOLE-PATH solar (it reports unpowered)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    // Solar at 900: in range of the connector (edge 900−300−24−40 = 536 ≤ 600)
    // but OUT of direct capital range (edge 900−80−40 = 780 > CONNECTION_MAX_RANGE
    // 600). The connector is its SOLE path to a hub — so destroying the connector
    // genuinely strands it, and the 1 Hz reconnect sweep (Issue 2) CANNOT heal it
    // (no other in-range hub). If the solar were at 600 it would re-wire straight
    // to the capital — that grid-healing case is the next test.
    const sol = await placeAndWait(harness, room, 'solar', 900, 0);
    // Capture entityIds BEFORE the connector is destroyed (its swarm record
    // is gone afterwards).
    const [capE, conE, solE] = [eid(harness, cap), eid(harness, con), eid(harness, sol)];
    for (let i = 0; i < 60; i++) internals.pulseStructureGrid();
    expect(sliceEntry(internals.getStructuresSlice(), solE)?.powered).toBe(true);

    // Destroy the connector via the same damage entry every weapon uses.
    internals.applyDamage(con, 'player-1', 99999);
    expect(internals.structureRegistry.has(con)).toBe(false);
    // Pulse a few times so the reconnect sweep gets every chance to (fail to) heal.
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();

    const slice = internals.getStructuresSlice();
    // Connector gone; solar severed (no connTo) and unpowered — no alternative hub.
    expect(sliceEntry(slice, conE)).toBeUndefined();
    expect(sliceEntry(slice, solE)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, solE)?.powered).toBe(false);
    // Capital still present + powered (its own component).
    expect(sliceEntry(slice, capE)?.powered).toBe(true);
  }, 20_000);

  it('a battery rides the slice with storedPower, charging from the capital surplus (batteries plan)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    await placeAndWait(harness, room, 'capital', 0, 0);
    await placeAndWait(harness, room, 'connector', 0, 140); // WS-5: battery routes via a relay
    const bat = await placeAndWait(harness, room, 'battery', 250, 0);
    const batE = eid(harness, bat);

    // Blueprint first: the field is present (battery kind) but empty.
    expect(sliceEntry(internals.getStructuresSlice(), batE)?.storedPowerMax).toBe(300);
    expect(sliceEntry(internals.getStructuresSlice(), batE)?.storedPower).toBe(0);

    // Drive construction (cost 600 / 5 per pulse = 120 pulses; +16 for the relay
    // Connector that must build FIRST under WS-5) then a few more so the built
    // battery banks the capital's +50/pulse surplus.
    for (let i = 0; i < 160; i++) internals.pulseStructureGrid();

    const entry = sliceEntry(internals.getStructuresSlice(), batE)!;
    expect(entry.built).toBe(true);
    expect(entry.powered).toBe(true); // capital-connected
    expect(entry.storedPowerMax).toBe(300); // the new wire field round-trips
    expect(entry.storedPower!).toBeGreaterThan(0); // charged from surplus
  }, 25_000);

  it('Phase 5 — destroying a relay ORPHANS a downstream leaf; it heals only on a MANUAL reconnect', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    await placeAndWait(harness, room, 'capital', 0, 0);
    // con1 is the solar's nearest hub at placement; con2 (also Capital-connected,
    // so it survives con1's death) is the in-range backup the player CAN reconnect
    // onto — but only deliberately, never via the auto-sweep (Phase 5).
    const con1 = await placeAndWait(harness, room, 'connector', 200, 0);
    const con2 = await placeAndWait(harness, room, 'connector', 0, 250);
    const sol = await placeAndWait(harness, room, 'solar', 250, 150);
    const [con2E, solE] = [eid(harness, con2), eid(harness, sol)];
    for (let i = 0; i < 60; i++) internals.pulseStructureGrid();
    expect(sliceEntry(internals.getStructuresSlice(), solE)?.powered).toBe(true);

    // Destroy the solar's hub. Phase 5: "if the connector a structure is connected
    // to is destroyed then it's just orphaned, the player must notice and manually
    // click reconnect" — the auto-sweep must NOT silently re-wire it (the old
    // behaviour, reversed here; the sweep now only links NEVER-connected nodes).
    internals.applyDamage(con1, 'player-1', 99999);
    expect(internals.structureRegistry.has(con1)).toBe(false);
    for (let i = 0; i < 5; i++) internals.pulseStructureGrid();

    let slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, solE)?.connTo ?? []).not.toContain(con2E); // NOT auto-healed
    expect(sliceEntry(slice, solE)?.powered).toBe(false); // orphaned ⇒ unpowered

    // The player MANUALLY reconnects → it heals onto the surviving Connector.
    expect(internals.reconnectStructure(sol)).toBe(true);
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, solE)?.connTo).toContain(con2E);
    expect(sliceEntry(slice, solE)?.powered).toBe(true);
  }, 20_000);
});
