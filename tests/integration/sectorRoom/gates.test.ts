/**
 * Phase V gates — a powered Shield Gate in a real room opens for the ships its
 * access setting admits, and the open state reaches clients through room state
 * (#16: a late joiner reads it from the join payload, never from an event).
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Shield Gate (0,-900). The
 * Capital's 50 power covers the gate's 30. A ship spawned at (0,-1150) sits in
 * the gate's approach zone (300 u either side of the span).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { GATE_OPEN_A } from '../../../src/core/structures/gateLogic.js';
import { GATE_APPROACH_DEPTH } from '../../../src/core/structures/gateGeometry.js';
import { structureHalfExtents } from '../../../src/shared-types/structureKinds.js';
import { DEFAULT_SHIP_KIND } from '../../../src/shared-types/shipKinds.js';
import { tuningFor } from '../../../src/shared-types/shipScale/lookup.js';

// Spawn in the approach zone but clear of the gate box (the join nudges a
// ship out of any structure by its kind's spawn clearance, which grows with
// the ship scale). Derived, so the layout holds at any scale.
const GATE_Y = -900;
const SPAWN_LY = structureHalfExtents('shield_gate').hh + tuningFor(DEFAULT_SHIP_KIND).spawnClearance + 10;

// Joins keep a requested playerId only when it is a UUID.
const OWNER = '6a7e0000-0000-4000-8000-0000000000a1';

function base(gateAccess?: 'allies' | 'owner' | 'open') {
  return [
    { kind: 'capital', x: 0, y: 0 },
    { kind: 'connector', x: 0, y: -350 },
    { kind: 'shield_gate', x: 0, y: GATE_Y, ...(gateAccess ? { gateAccess } : {}) },
  ];
}

describe('SectorRoom integration — Shield Gate opens on approach (phase V gates)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('the spawn sits in the approach zone at this ship scale', () => {
    expect(SPAWN_LY).toBeLessThanOrEqual(GATE_APPROACH_DEPTH);
  });

  async function boot(gateAccess?: 'allies' | 'owner' | 'open') {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: base(gateAccess),
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: GATE_Y - SPAWN_LY,
    });
    // The room exists once a client joins. A pending (not yet active) hull never
    // opens a gate, so this observer leaves the gate untouched.
    const observer = await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const gate = [...internals.structureRegistry.all()].find((r) => r.kind === 'shield_gate')!;
    expect(gate, 'the gate was seeded').toBeDefined();
    return { internals, gate, observer };
  }

  it('opens for its owner, and the open state is in room state', async () => {
    const { internals, gate, observer } = await boot();
    // Closed and blocking before anyone arrives: a shot up the gap stops at the span.
    await harness.advance(300);
    expect(internals.gateMask(gate.id)).toBe(0);
    expect(internals.blockShotAtWall(0, -1100, 0, 1, 400, 1)).not.toBeNull();

    await harness.connectActive(OWNER);
    await harness.advance(500);
    expect(internals.gateMask(gate.id)).toBe(GATE_OPEN_A);
    // Open ⇒ the span no longer absorbs shots through the gap.
    expect(internals.blockShotAtWall(0, -1100, 0, 1, 400, 1)).toBeNull();
    // The client sees it in room state.
    const entityId = String(internals.swarmRegistry.get(gate.id)!.entityId);
    const row = observer.state.structures.get(entityId) as { gateOpen?: number } | undefined;
    expect(row?.gateOpen).toBe(GATE_OPEN_A);
  });

  it('stays shut for a stranger under the default access (owner + allies)', async () => {
    const { internals, gate } = await boot();
    await harness.connectActive(randomUUID());
    await harness.advance(500);
    expect(internals.gateMask(gate.id)).toBe(0);
    expect(internals.blockShotAtWall(0, -1100, 0, 1, 400, 1)).not.toBeNull();
  });

  it('opens for a stranger when set to "anyone not hostile"', async () => {
    const { internals, gate } = await boot('open');
    await harness.connectActive(randomUUID());
    await harness.advance(500);
    expect(internals.gateMask(gate.id)).toBe(GATE_OPEN_A);
  });

  it('only the owner can change who it opens for', async () => {
    const { internals, gate } = await boot();
    const entityId = internals.swarmRegistry.get(gate.id)!.entityId;
    const stranger = await harness.connectAs(randomUUID());
    stranger.send('set_gate_access', { type: 'set_gate_access', entityId, access: 'open' });
    await harness.advance(200);
    expect(gate.gateAccess ?? 0).toBe(0);
    const owner = await harness.connectAs(OWNER);
    owner.send('set_gate_access', { type: 'set_gate_access', entityId, access: 'open' });
    await harness.advance(200);
    expect(gate.gateAccess).toBe(2);
  });
});
