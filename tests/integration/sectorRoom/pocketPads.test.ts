/**
 * Wrap-up W1b — transit pads (rare, instant, safe). In a solar-system sector
 * that has a pad pair (sol-prime does; most systems don't, `pocketPadPair`),
 * the room seeds two built, Traders-owned pads, paired, set to fire when a
 * ship boards, needing no charge or grid. A pilot sitting on the home pad
 * rides it to the other pocket.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { pocketPadPair, POCKET_PAD_OWNER } from '../../../src/core/galaxy/sectorSites.js';

const PILOT = 'face0000-0000-4000-8000-0000000000a1';

describe('SectorRoom integration — transit pads (W1b)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('seeds a paired, built, free pad pair and a pilot on the home pad rides it', { timeout: 30_000 }, async () => {
    const pair = pocketPadPair('sol-prime')!;
    expect(pair).not.toBeNull();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      galaxyBases: false, alienGates: false, solarSectors: true, pocketPads: true,
      teleportCycleScale: 0.01,
    } as never);
    await harness.connectActive(PILOT, { shipKind: 'fighter', spawnX: pair.ax, spawnY: pair.ay });
    const internals = harness.getServerRoom()!._internals;
    const pads = [...internals.structureRegistry.all()].filter((r) => r.kind === 'pocket_pad');
    expect(pads).toHaveLength(2);
    const home = pads.find((r) => Math.hypot(r.x - pair.ax, r.y - pair.ay) < 3000)!;
    const far = pads.find((r) => r !== home)!;
    expect(home).toBeDefined();
    expect(Math.hypot(far.x - pair.bx, far.y - pair.by)).toBeLessThan(3000);
    for (const p of pads) {
      expect(p.owner).toBe(POCKET_PAD_OWNER);
      expect(p.isConstructed).toBe(true);
      expect(p.tpRules?.shipBoards).toBe(true);
    }
    expect(home.tpPartner?.uid).toBe(far.uid);

    await harness.advance(50);
    expect(Math.hypot(internals.playerPose(PILOT)!.x - home.x, internals.playerPose(PILOT)!.y - home.y)).toBeLessThan(320);
    expect(internals.playerPose(PILOT)!.poseEpoch).toBe(0);
    for (let i = 0; i < 200 && internals.playerPose(PILOT)!.poseEpoch === 0; i++) {
      internals.pulseStructureGrid();
      internals.tickStructureTurrets();
      await harness.advance(30);
    }
    const after = internals.playerPose(PILOT)!;
    expect(after.poseEpoch).toBe(1);
    expect(Math.hypot(after.x - far.x, after.y - far.y)).toBeLessThan(1500);
  });

  it('seeds nothing in a system without a pair', { timeout: 20_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'vega-reach', droneCount: 0, testMode: true, asteroidConfig: [],
      galaxyBases: false, alienGates: false, solarSectors: true, pocketPads: true,
    } as never);
    await harness.connectActive(PILOT);
    expect(pocketPadPair('vega-reach')).toBeNull();
    const internals = harness.getServerRoom()!._internals;
    expect([...internals.structureRegistry.all()].filter((r) => r.kind === 'pocket_pad')).toHaveLength(0);
  });
});
