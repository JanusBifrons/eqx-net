/**
 * User ruling (2026-11-02): a fence blocks every ship and shot, the owner's
 * own turret fire included — "No they don't pass through."
 *
 * Before the fix a BEAM turret applied its damage straight to the target and
 * never asked the shield walls, so it fired through any fence (its owner's or
 * anyone's), while bolts were already absorbed. This locks the beam: a turret
 * behind its own powered wall engages a drone on the far side, and the hit
 * lands on the wall, not the drone.
 *
 * Layout (the shieldFence.test layout + a turret): Capital (0,0) → Connector
 * (400,0) → pylons (520,0) and (520,500) forming a wall along x = 520; a
 * Turret at (400,250) west of the wall; the drone at (900,250) east of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — turret fire vs its own fence', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  for (const kind of ['turret', 'missile_turret'] as const) it(`a ${kind}'s fire stops at its own powered wall; the drone beyond is untouched`, { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      droneCount: 0,
      testMode: true,
      peacefulDrones: true,
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 400, y: 0 },
        { kind: 'shield_pylon', x: 520, y: 0 },
        { kind: 'shield_pylon', x: 520, y: 500 },
        { kind, x: 400, y: 250 },
        { kind: 'solar', x: -200, y: 500 },
        { kind: 'connector', x: -200, y: 330 },
        // A charged battery so a missile is absorbed, not an overload stun
        // (a stunned wall is open by design).
        { kind: 'battery', x: -480, y: 330 },
      ],
      defaultSpawnX: -2500,
      defaultSpawnY: 0,
    });
    const observer = await harness.connectAs(randomUUID());
    const hits: Array<{ shooterId?: string; targetId?: string }> = [];
    observer.onMessage('damage', (e: { shooterId?: string; targetId?: string }) => hits.push(e));
    const internals = harness.getServerRoom()!._internals;
    const turret = [...internals.structureRegistry.all()].find((r) => r.kind === kind)!;
    // Missiles spend munitions: stock the Capital's hold.
    const capital = [...internals.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    capital.hold = { goods: { munitions: 10 }, blueprints: [] };
    const battery = [...internals.structureRegistry.all()].find((r) => r.kind === 'battery')!;
    const pylon = [...internals.structureRegistry.all()].find((r) => r.kind === 'shield_pylon')!;
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    battery.storedPower = 100_000; // full (capped at its capacity on the next pulse)
    internals.pulseStructureGrid();
    const eid = internals.swarmRegistry.get(pylon.id)!.entityId;
    expect(internals.getStructuresSlice()?.find((s) => s.id === eid)?.wallActive, 'the wall is up').toBe(true);

    expect(internals.spawnTestDrone('raider', 900, 250)).toBe(true);
    await harness.advance(100);
    let engaged = false;
    let fired = 0;
    observer.onMessage('missile_fired', () => fired++);
    for (let i = 0; i < 6; i++) {
      internals.tickStructureTurrets();
      if (turret.turretTargetEntityId !== undefined) engaged = true;
      await new Promise((r) => setTimeout(r, 650)); // past the turret's 600 ms beam cadence
    }
    await harness.advance(kind === 'missile_turret' ? 3000 : 200);
    expect(engaged, 'the turret did engage the drone (powered ' + JSON.stringify({ noAmmo: turret.noAmmo, drawFull: turret.drawFull }) + ')').toBe(true);
    // It did fire (munitions spent), whether the wall caught the missile in
    // flight or at the muzzle.
    if (kind === 'missile_turret') expect(capital.hold?.goods.munitions ?? 0, 'it fired (fired msgs: ' + fired + ')').toBeLessThan(10);
    const onDrone = hits.filter((h) => h.shooterId === turret.id && h.targetId !== undefined && !String(h.targetId).startsWith('pstruct-'));
    expect(onDrone, 'no hit got through its own fence: ' + JSON.stringify(onDrone)).toEqual([]);
  });
});
