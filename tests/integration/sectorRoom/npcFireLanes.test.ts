/**
 * Fire-lane awareness (AI slice 5b, plan composed-harbor §4 + §2; owner
 * 2026-11-13: NPCs "trying not to shoot each other as friendly hits impact
 * shields"). The room's LineOfFireGate holds an NPC shot while a friendly body
 * is on its line (slice 2) and tells the brain (slice 5a). This slice makes
 * the brain MOVE: a blocked ship side-steps off the line, and ships keep out
 * of wingmen's fire lanes. Ships fly only with player controls.
 *
 * Each scene runs twice, with the feature on and off (`setFireLaneAvoidance`,
 * a module switch in core: the harness runs the room in this process), and
 * counts the gate's holds (`aiController.noteBlocked`) and friendly hits
 * (`applyDamage` where shooter and victim are both in the pack).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { setFireLaneAvoidance } from '../../../src/core/ai/tactics/fireLanes.js';

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmHealth: Map<string, number>;
    setNpcLineOfFire(on: boolean): void;
  };
  aiController: { noteBlocked(id: string, tick: number, x: number, y: number): void };
  serverTick: number;
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
}

interface SceneResult {
  /** Gate holds (`noteBlocked`) after `warmMs` (one shooter, or the pack). */
  blocks: number;
  blocksBeforeWarm: number;
  friendlyHits: number;
  pilotHits: number;
}

async function runScene(
  on: boolean,
  poses: Array<{ x: number; y: number }>,
  warmMs: number,
  totalMs: number,
  onlyShooter?: number,
  gate = true,
): Promise<{ harness: SectorTestHarness; result: SceneResult }> {
  setFireLaneAvoidance(on);
  const harness = await bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    testMode: true,
    asteroidConfig: [],
    dronePoses: poses.map((p) => ({ kind: 'fighter', x: p.x, y: p.y, angle: 0, hullExposed: false })),
    lockTimeCapS: 0,
    defaultSpawnX: 0,
    defaultSpawnY: 0,
  });
  const pilot = randomUUID();
  await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
  const room = harness.getServerRoom()! as unknown as Room;
  room._internals.setNpcLineOfFire(gate);
  const recs = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
  // Endless hulls: no drone dies mid-window (friendly fire hurts).
  for (const rec of recs) room._internals.swarmHealth.set(rec.id, 1e9);
  const ids = recs.filter((r) => r.shipKind === 'fighter').map((r) => r.id);
  expect(ids.length).toBe(poses.length);
  const pack = new Set(ids);
  const shooter = onlyShooter === undefined ? null : ids[onlyShooter]!;
  let warm = false;
  const r: SceneResult = { blocks: 0, blocksBeforeWarm: 0, friendlyHits: 0, pilotHits: 0 };
  const ai = room.aiController;
  const origNote = ai.noteBlocked.bind(ai);
  ai.noteBlocked = (id, tick, x, y) => {
    if (shooter === null || id === shooter) {
      if (warm) r.blocks++;
      else r.blocksBeforeWarm++;
    }
    origNote(id, tick, x, y);
  };
  const origDmg = room.applyDamage.bind(room);
  room.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    if (warm && pack.has(t) && pack.has(s)) r.friendlyHits++;
    if (warm && t === pilot) r.pilotHits++;
    origDmg(t, s, ...rest);
  };
  await harness.advance(warmMs);
  warm = true;
  await harness.advance(totalMs - warmMs);
  return { harness, result: r };
}

describe('SectorRoom integration — NPC fire lanes (AI slice 5b)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    setFireLaneAvoidance(true);
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 15_000);

  it('a drone whose shot an ally blocks clears its line: blocked attempts after the first second drop by ≥ 50 %', { timeout: 60_000 }, async () => {
    // A column on the pilot: the shooter's wingman sits right on its line.
    const poses = [{ x: 0, y: -700 }, { x: 0, y: -520 }];
    const on = await runScene(true, poses, 1000, 6000, 0);
    harness = on.harness;
    await harness.cleanup();
    harness = undefined;
    const off = await runScene(false, poses, 1000, 6000, 0);
    harness = off.harness;
    console.log(`[npcFireLanes] column on=${JSON.stringify(on.result)} off=${JSON.stringify(off.result)}`);
    expect(off.result.blocks, 'the control is blocked (the scene works)').toBeGreaterThan(0);
    expect(on.result.blocks, 'side-steps clear the line').toBeLessThanOrEqual(off.result.blocks * 0.5);
  });

  // Four drones in a column on one pilot: each sits in the next one's line.
  it('a 4-drone pack on one target: fewer held shots with the gate, fewer friendly hits without it (20 s each)', { timeout: 200_000 }, async () => {
    const poses = [{ x: 0, y: -850 }, { x: 0, y: -700 }, { x: 0, y: -550 }, { x: 0, y: -400 }];
    const out: Record<string, SceneResult> = {};
    for (const gate of [true, false]) {
      for (const on of [true, false]) {
        const r = await runScene(on, poses, 2000, 20_000, undefined, gate);
        harness = r.harness;
        await harness.cleanup();
        harness = undefined;
        out[(gate ? 'gate' : 'nogate') + (on ? 'On' : 'Off')] = r.result;
      }
    }
    console.log('[npcFireLanes] pack ' + JSON.stringify(out));
    const { gateOn, gateOff, nogateOn, nogateOff } = out as Record<'gateOn' | 'gateOff' | 'nogateOn' | 'nogateOff', SceneResult>;
    // With the gate (production): the gate already stops friendly hits; the
    // movement cuts the shots it has to hold.
    expect(gateOff.blocks, 'the control is blocked (the scene works)').toBeGreaterThan(20);
    expect(gateOn.blocks, 'held shots drop by half or more').toBeLessThanOrEqual(gateOff.blocks * 0.5);
    expect(gateOn.friendlyHits).toBeLessThanOrEqual(gateOff.friendlyHits);
    // Without the gate, lane avoidance alone: fewer friendly hits.
    expect(nogateOff.friendlyHits, 'the control shoots its wingmen').toBeGreaterThan(20);
    expect(nogateOn.friendlyHits, 'ships leave wingmen lanes: friendly hits halve').toBeLessThanOrEqual(nogateOff.friendlyHits * 0.5);
    expect(gateOn.pilotHits, 'the pack still fights').toBeGreaterThan(0);
  });
});
