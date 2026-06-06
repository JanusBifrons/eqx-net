/**
 * Generic Entity Pipeline P4 — the "structure for free" proof, through the real
 * SectorRoom (the server-CLAUDE.md "new visible entity ⇒ integration test
 * through the full path" mandate).
 *
 * A structure is a NEW pose-core entity type (binary swarm kind byte = 2). The
 * thesis of the whole refactor: adding it wires send + construct + render +
 * damage cheaply, with NO new dispatch code in DamageRouter / ProjectilePipeline
 * / MissileSimulation / ShieldHullRouter. This test exercises the SERVER half:
 *  - SEND/CONSTRUCT: it spawns as a kind=2 swarm-registry record, so it rides
 *    the EXISTING binary encoder + broadcast + interest path unchanged.
 *  - DAMAGE: seeding `swarmHealth` (the only structure-specific server line) is
 *    what makes it damageable — `DamageRouter.apply` routes it through the
 *    unchanged 'swarm' strategy (resolve → damageSwarmLayered → evict on 0).
 *
 * Reproduction: spawn a structure via the `structurePoses` testMode trigger,
 * then drive damage through `_internals.applyDamage` (the same entry every
 * projectile/missile/ram hit uses) and assert the health pool + eviction.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { STRUCTURE_DEFAULT_HEALTH } from '../../../src/core/swarm/structureConstants.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import { SCAFFOLDING_HP_FRACTION } from '../../../src/core/structures/structureGridConstants.js';

describe('SectorRoom integration — structure entity (GEP P4 "for free" proof)', () => {
  let harness: SectorTestHarness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('spawns a kind=2 structure that is damageable + destroyable through the EXISTING swarm path', async () => {
    harness = await bootSectorTestServer({
      structurePoses: [{ id: 'struct-A', x: 200, y: 0, radius: 50 }],
    });
    // Joining creates the room; onCreate seeds the structure synchronously.
    await harness.connectAs('player-1');
    const room = harness.getServerRoom();
    expect(room).not.toBeNull();
    const internals = room!._internals;

    // SEND + CONSTRUCT for free: the structure is a kind=2 swarm-registry record
    // — it rides the existing binary encoder/broadcast with zero encoder change.
    const rec = internals.swarmRegistry.get('struct-A');
    expect(rec).toBeTruthy();
    expect(rec!.kind).toBe(2);

    // DAMAGE for free: swarmHealth presence (the one structure-specific line)
    // makes it vulnerable through the unchanged DamageRouter 'swarm' strategy.
    expect(internals.swarmHealth.get('struct-A')).toBe(STRUCTURE_DEFAULT_HEALTH);

    // A confirmed hit via the SAME applyDamage entry every weapon path uses.
    internals.applyDamage('struct-A', 'player-1', 30);
    expect(internals.swarmHealth.get('struct-A')).toBe(STRUCTURE_DEFAULT_HEALTH - 30);

    // Overkill destroys it — evicted through the same swarm death policy.
    internals.applyDamage('struct-A', 'player-1', 9999);
    expect(internals.swarmRegistry.get('struct-A') ?? null).toBeNull();
    expect(internals.swarmHealth.has('struct-A')).toBe(false);
  }, 15_000);

  it('a structure is immune-free (unlike an asteroid): it has a swarmHealth pool from spawn', async () => {
    harness = await bootSectorTestServer({
      structurePoses: [{ id: 'struct-B', x: -150, y: 80, radius: 40, mass: 9000 }],
    });
    await harness.connectAs('player-2');
    const internals = harness.getServerRoom()!._internals;

    // Asteroids are ABSENT from swarmHealth (immune); a structure is present —
    // that single difference is the whole "damageable static object" story.
    expect(internals.swarmHealth.has('struct-B')).toBe(true);
    expect(internals.swarmRegistry.get('struct-B')!.kind).toBe(2);
  }, 15_000);

  // ── Structures plan, Phase 2 — player-driven placement over the wire ──────
  it('place_structure (Capital) spawns a PRE-BUILT kind=2 structure carrying its subtype', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    room.send('place_structure', { type: 'place_structure', kind: 'capital', x: 1200, y: -300 });

    // Wait for the server handler + spawn to land.
    const deadline = Date.now() + 3000;
    let placedId: string | null = null;
    while (Date.now() < deadline && placedId === null) {
      for (const rec of internals.structureRegistry.all()) {
        placedId = rec.id;
        break;
      }
      if (placedId === null) await harness.advance(40);
    }
    expect(placedId).not.toBeNull();

    const srec = internals.structureRegistry.get(placedId!)!;
    // Owner is the session's durable playerId (a UUID from the identify
    // handshake), not the join hint — just assert it's tagged. The exact
    // owner-gating is locked in StructurePlacementSubsystem.test.ts.
    expect(srec.owner).toBeTruthy();
    expect(srec.kind).toBe('capital');
    expect(srec.isConstructed).toBe(true); // capital is pre-built

    // It rides the kind=2 swarm path and carries the subtype on the wire byte.
    const wrec = internals.swarmRegistry.get(placedId!)!;
    expect(wrec.kind).toBe(2);
    expect(wrec.shipKind).toBe('capital');
    // Pre-built ⇒ full hull seeded (damageable through the swarm path).
    expect(internals.swarmHealth.get(placedId!)).toBe(getStructureKind('capital').maxHealth);
  }, 15_000);

  it('place_structure (Connector) spawns a BLUEPRINT at 10% HP that is destroyable', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    room.send('place_structure', { type: 'place_structure', kind: 'connector', x: -800, y: 600 });

    const deadline = Date.now() + 3000;
    let placedId: string | null = null;
    while (Date.now() < deadline && placedId === null) {
      for (const rec of internals.structureRegistry.all()) {
        placedId = rec.id;
        break;
      }
      if (placedId === null) await harness.advance(40);
    }
    expect(placedId).not.toBeNull();

    const srec = internals.structureRegistry.get(placedId!)!;
    expect(srec.kind).toBe('connector');
    expect(srec.isConstructed).toBe(false); // blueprint
    expect(srec.constructionProgress).toBe(0);

    const kind = getStructureKind('connector');
    const expectedHp = Math.floor(kind.maxHealth * SCAFFOLDING_HP_FRACTION);
    expect(internals.swarmHealth.get(placedId!)).toBe(expectedHp);

    // The fragile scaffolding dies through the SAME swarm damage path.
    internals.applyDamage(placedId!, 'player-1', 9999);
    expect(internals.swarmRegistry.get(placedId!) ?? null).toBeNull();
    expect(internals.swarmHealth.has(placedId!)).toBe(false);
  }, 15_000);
});
