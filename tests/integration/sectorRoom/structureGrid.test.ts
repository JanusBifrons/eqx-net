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

function sliceEntry(slice: StructuresSlice | undefined, id: string): StructuresSlice[number] | undefined {
  return slice?.find((s) => s.id === id);
}

describe('SectorRoom integration — structure grid (Phase 3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('capital → connector → solar form a powered web (connTo + positive netPower)', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const sol = await placeAndWait(harness, room, 'solar', 600, 0);

    // The web forms on placement (connTo present immediately), even as blueprints.
    let slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, con)?.connTo).toContain(cap);
    expect(sliceEntry(slice, sol)?.connTo).toContain(con);

    // Drive construction to completion (connector then solar).
    for (let i = 0; i < 60; i++) internals.pulseStructureGrid();

    slice = internals.getStructuresSlice();
    const solEntry = sliceEntry(slice, sol)!;
    expect(solEntry.built).toBe(true);
    expect(solEntry.powered).toBe(true);
    expect(solEntry.netPower).toBe(80); // capital 50 + solar 30
    // buildPct omitted once complete.
    expect(solEntry.buildPct).toBeUndefined();
  }, 20_000);

  it('a leaf with no hub in range is unconnected + unpowered (leaf↔leaf rejected)', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    await placeAndWait(harness, room, 'capital', 0, 0);
    // Two solars far from the capital but near each other.
    const s1 = await placeAndWait(harness, room, 'solar', 3000, 0);
    const s2 = await placeAndWait(harness, room, 'solar', 3120, 0);
    for (let i = 0; i < 5; i++) internals.pulseStructureGrid();

    const slice = internals.getStructuresSlice();
    expect(sliceEntry(slice, s1)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, s2)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, s1)?.powered).toBe(false);
    expect(sliceEntry(slice, s2)?.powered).toBe(false);
  }, 20_000);

  it('destroying the connector severs the solar (it reports unpowered)', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const sol = await placeAndWait(harness, room, 'solar', 600, 0);
    for (let i = 0; i < 60; i++) internals.pulseStructureGrid();
    expect(sliceEntry(internals.getStructuresSlice(), sol)?.powered).toBe(true);

    // Destroy the connector via the same damage entry every weapon uses.
    internals.applyDamage(con, 'player-1', 99999);
    expect(internals.structureRegistry.has(con)).toBe(false);
    internals.pulseStructureGrid();

    const slice = internals.getStructuresSlice();
    // Connector gone; solar severed (no connTo) and unpowered.
    expect(sliceEntry(slice, con)).toBeUndefined();
    expect(sliceEntry(slice, sol)?.connTo).toBeUndefined();
    expect(sliceEntry(slice, sol)?.powered).toBe(false);
    // Capital still present + powered (its own component).
    expect(sliceEntry(slice, cap)?.powered).toBe(true);
  }, 20_000);
});
