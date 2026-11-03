/**
 * v4 M2 — a garrison's patrol, in a real Sol Prime room growing its real NPC
 * bases (the region power's garrison is one of them).
 *
 *  - The patrol ships spawn with the garrison and fly for its owner: their
 *    snapshot entries carry `drones[].fac`.
 *  - A neutral pilot near the base is left alone.
 *  - Once that pilot attacks the garrison (a hostile act), the patrol is told
 *    to engage: `bot_aggro` names the pilot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { resolveSectorConfig } from '../../../src/server/galaxy/GalaxyRegistry.js';
import { MILITARY_BASE_ID, galaxyBasePlan } from '../../../src/core/bases/galaxyBases.js';

const KEY = 'sol-prime';

describe('SectorRoom integration — garrison patrols (v4 M2)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('patrols fly for the owner, ignore a neutral pilot, and engage once the pilot attacks the base', { timeout: 40_000 }, async () => {
    const mil = galaxyBasePlan(KEY).find((b) => b.baseId === MILITARY_BASE_ID)!;
    const owner = `npc:${mil.profile.ownerFaction}:${MILITARY_BASE_ID}`;
    const cfg = resolveSectorConfig(KEY);
    harness = await bootSectorTestServer({
      sectorKey: KEY, droneCount: 0, testMode: true, asteroidConfig: cfg.asteroidConfig as never, galaxyBases: true,
    });
    // The room is created by the first join.
    await harness.connectActive(randomUUID());
    const room = harness.getServerRoom()!;
    const internal = room._internals;
    const garrison = [...internal.structureRegistry.all()].filter((r) => r.owner === owner);
    expect(garrison.length).toBeGreaterThan(0);
    const patrolIds = [...internal.swarmRegistry.all()].map((r) => r.id).filter((id) => id.startsWith('patrol-'));
    expect(patrolIds.length, 'the garrison flies a patrol').toBeGreaterThanOrEqual(3);

    // A pilot parks just outside the garrison.
    const cx = garrison.reduce((n, r) => n + r.x, 0) / garrison.length;
    const cy = garrison.reduce((n, r) => n + r.y, 0) / garrison.length;
    const pilot = randomUUID();
    const client = await harness.connectActive(pilot, { spawnX: Math.round(cx), spawnY: Math.round(cy + 2600) });
    const facs = new Set<string>();
    client.onMessage('snapshot', (snap: { drones?: Array<{ fac?: string }> }) => {
      for (const d of snap.drones ?? []) if (d.fac !== undefined) facs.add(d.fac);
    });
    const aggro: string[] = [];
    client.onMessage('bot_aggro', (m: { targetPlayerId: string }) => aggro.push(m.targetPlayerId));

    for (let i = 0; i < 4; i++) {
      internal.pulseStructureGrid();
      await harness.advance(250);
    }
    expect(facs.has(mil.profile.ownerFaction), 'patrol entries carry the owner faction').toBe(true);
    expect(aggro, 'a neutral pilot is left alone').toEqual([]);

    // The pilot attacks the garrison: a hostile act against its owner.
    internal.applyDamage(garrison[0]!.id, pilot, 10);
    for (let i = 0; i < 3 && aggro.length === 0; i++) {
      internal.pulseStructureGrid();
      await harness.advance(250);
    }
    expect(aggro).toContain(pilot);
  });
});
