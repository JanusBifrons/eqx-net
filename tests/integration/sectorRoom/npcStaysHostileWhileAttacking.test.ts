/**
 * An NPC that is itself attacking stays hostile (owner decision 2026-11-12):
 * "Its own lock and its own hits on you also keep it hostile; it forgets you
 * 30 s after it last hit or held a lock on you."
 *
 * Symptom (probe on showcase-capital-duel, PR #514): one `test_aggro`, a pilot
 * who never fights back. Hostility was refreshed only by the PILOT's hits on
 * the NPC or the pilot's lock on it, so the battleship forgot the pilot 30 s
 * after the cue, partway through its 30 s 16" reload: one volley, then its
 * turrets went home.
 *
 * Rule now: hostility decays 30 s after the latest of the pilot's last hit on
 * the NPC, the pilot's last lock on it, the NPC's last hit on the pilot, and
 * the NPC's last held lock on the pilot. A lock drops out of reach, so a
 * pilot who leaves is forgotten 30 s later (no feedback loop).
 *
 * Layout: the duel room with the battleship turned so the pilot sits 40° off
 * its bow (forward turrets bear in ~10 s), as in turretsTrackWhileReloading.
 * The pilot's groups start in MAN so it never locks back (passive).
 *
 * Game time for the decay checks: the room clock can't be fast-forwarded, so
 * (as in lockKeepsHostile.test.ts) the test AGES the ledger, re-marking the
 * last hostile act 1790 ticks (29.8 s) in the past, then lets ~1 s run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_CAPITAL_DUEL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';
import { getShipKind, type WeaponMount, type ShipKind } from '../../../src/shared-types/shipKinds.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';

/** Just inside the 30 s (1800-tick) hostility window. */
const AGE_TICKS = 1790;

interface RoomPeek {
  mountTicker: { droneMountAngles: Map<string, Float32Array> };
  aiController: {
    markHostile(id: string, pid: string, tick: number): void;
    getBehaviour(id: string): { hostileTo?: Set<string> } | undefined;
  };
  npcLocks: { isLocked(npcId: string, pilotId: string): boolean; wireFor(pid: string): unknown[] | undefined };
  shipPoseCache: Map<string, { x: number; y: number }>;
  resolveSlotMounts(kind: ShipKind): ReadonlyArray<WeaponMount>;
  postToWorker(cmd: unknown): void;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — an attacking NPC stays hostile', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    const d = SHOWCASE_CAPITAL_DUEL_OPTS;
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: d.peacefulDrones,
      pilotCapitals: d.pilotCapitals,
      prebuiltStructures: d.prebuiltStructures,
      defaultSpawnX: d.defaultSpawnX,
      defaultSpawnY: d.defaultSpawnY,
      dronePoses: [{ kind: 'battleship', x: 0, y: 0, angle: (-50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function setup(aggro: boolean) {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0,
      groupMode: 'manual', // passive: never locks or fires back
    });
    const server = harness.getServerRoom() as unknown as SectorRoom;
    const peek = server as unknown as RoomPeek;
    const npc = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(npc).toBeDefined();
    const salvos: number[] = [];
    cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'naval_xl') salvos.push(Date.now()); });
    const cueAt = Date.now();
    if (aggro) cr.send('test_aggro', { type: 'test_aggro' });
    const tick = (): number => server._internals.serverTick;
    const hostile = (): boolean => peek.aiController.getBehaviour(npc.id)?.hostileTo?.has(pid) === true;
    return { pid, cr, server, peek, npc, salvos, cueAt, tick, hostile };
  }

  it('a passive pilot: the battleship stays hostile past 30 s and fires a second 16" volley after its reload', { timeout: 110_000 }, async () => {
    const { salvos, cueAt, hostile } = await setup(true);
    await waitUntil(() => hostile(), 3000, 'cue makes it hostile');
    await waitUntil(() => salvos.length > 0, 40_000, 'first 16" volley');
    const first = salvos[0]!;
    const reloadMs = (getWeapon('naval_xl').cooldownTicks / 60) * 1000;
    // Past the old 30 s decay from the cue it is still hostile.
    await waitUntil(() => Date.now() - cueAt >= 33_000, 40_000, '33 s after the cue');
    expect(hostile(), 'still hostile 33 s after a single cue').toBe(true);
    // A volley a full reload after the first one = the same turret fired again.
    await waitUntil(() => salvos.some((t) => t >= first + reloadMs - 1000), reloadMs + 20_000, 'second 16" volley after the reload');
    expect(hostile()).toBe(true);
  });

  it('the pilot leaves reach: the NPC lock drops, hostility ends 30 s later and the turrets go home', { timeout: 60_000 }, async () => {
    const { pid, peek, npc, tick, hostile } = await setup(true);
    await waitUntil(() => peek.npcLocks.isLocked(npc.id, pid), 30_000, 'battleship locks the pilot');
    // In reach and locked: its own lock keeps it hostile past 30 s of no pilot action.
    peek.aiController.markHostile(npc.id, pid, tick() - AGE_TICKS);
    const t0 = tick();
    await waitUntil(() => tick() - t0 >= 60, 5000, '1 s of ticks');
    expect(hostile(), 'its own held lock keeps it hostile').toBe(true);

    // The pilot flies far out of reach (well past the 16" reach).
    const away = (): void => peek.postToWorker({ type: 'SET_POSITION', entityId: pid, x: 0, y: -25_000, angle: 0, vx: 0, vy: 0, angvel: 0 });
    away();
    await waitUntil(() => (peek.shipPoseCache.get(pid)?.y ?? 0) < -20_000, 5000, 'pilot moved away');
    await waitUntil(() => peek.npcLocks.wireFor(pid) === undefined, 10_000, 'NPC lock drops');
    // No more refresh: with the last hostile act aged to 29.8 s, ~1 s later it forgets.
    peek.aiController.markHostile(npc.id, pid, tick() - AGE_TICKS);
    const t1 = tick();
    await waitUntil(() => tick() - t1 >= 60, 5000, '1 s of ticks');
    expect(hostile(), 'forgotten once 30 s have passed since its lock dropped').toBe(false);

    // Turrets go home: every 16" turret's angle is at home or moving toward it.
    const mounts = peek.resolveSlotMounts(getShipKind('battleship'));
    const xl = mounts.map((m, i) => (m.weaponId === 'naval_xl' ? i : -1)).filter((i) => i >= 0);
    const angles = peek.mountTicker.droneMountAngles.get(npc.id)!;
    const before = xl.map((i) => Math.abs(angles[i]!));
    await new Promise((r) => setTimeout(r, 2000));
    xl.forEach((i, k) => {
      const now = Math.abs(angles[i]!);
      if (before[k]! > 0.02) expect(now, `turret ${mounts[i]!.id} homing`).toBeLessThan(before[k]!);
      else expect(now).toBeLessThan(0.03);
    });
  });

  it('no aggro: a pilot who never provokes is never targeted', { timeout: 30_000 }, async () => {
    const { pid, peek, npc, salvos, hostile } = await setup(false);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      expect(hostile()).toBe(false);
      expect(peek.npcLocks.wireFor(pid)).toBeUndefined();
      expect(peek.npcLocks.isLocked(npc.id, pid)).toBe(false);
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(salvos.length).toBe(0);
  });
});
