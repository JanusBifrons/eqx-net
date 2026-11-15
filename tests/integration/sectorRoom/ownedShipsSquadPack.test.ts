/**
 * RTS Part B slice 10 — squads fly as a loose pack on the AI pilot brain, and
 * Escort guards a zone that follows the escorted ship.
 *
 * - A squad following the ship its owner flies keeps within a loose radius
 *   of it while it moves (the members' AI pilots flock on it: the same pack
 *   flying as the AI pilots' own packs).
 * - A member under fire from an attacker it cannot see keeps following.
 *   Failing first: with nothing to shoot in COMBAT the brain flew its patrol
 *   orbit and ignored its leader, so the member left the pack.
 * - An Escort squad turns on a ship that shoots the escorted ship (owner
 *   2026-11-15: the guarded ship counts as a member of the squad, inside the
 *   existing retaliation rule). Failing first: only a hit on an AI-flown hull
 *   turned anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

interface Pose { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }

const FIGHTER = shipTuning(getShipKind('fighter'));
/** "A loose pack": every member within this of the ship it follows. */
const PACK_RADIUS = 4 * FIGHTER.flockFollow;

describe('SectorRoom integration — squads fly as a pack; Escort (RTS Part B slice 10)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  /** Park `n` fighters for `pid` at the given spots (the last by Spectate);
   *  returns their ids and the still-connected client (spectating). */
  async function parkHulls(pid: string, spots: ReadonlyArray<readonly [number, number]>) {
    let client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: spots[0]![0], spawnY: spots[0]![1] });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const activeOf = (): string => {
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    const ids: string[] = [];
    for (let i = 1; i < spots.length; i++) {
      ids.push(activeOf());
      await harness.disconnectClient(client);
      await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
      client = await harness.connectActive(pid, { isNewShip: true, shipKind: 'fighter', spawnX: spots[i]![0], spawnY: spots[i]![1] });
    }
    ids.push(activeOf());
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    return { room, state, client, ids };
  }

  it('a squad following the ship its owner flies stays within a loose radius of it while it moves', async () => {
    const pid = randomUUID();
    const { room, state, client, ids } = await parkHulls(pid, [[0, 0], [250, -250], [-250, -250]]);
    const [A, B, C] = ids as [string, string, string];
    const internals = room._internals;
    const fleet = internals.fleet;
    expect(fleet.formSquad(pid, [A, B, C])).not.toBeNull();
    client.send('pilot_ship', { type: 'pilot_ship', shipId: A });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);
    expect(state.ships.get(A)?.isActive, 'the owner flies A').toBe(true);
    for (const id of [B, C]) expect(internals.aiBrainOf(id)?.getFlockLeaderId?.()).toBe(A);

    const r = room as unknown as { entityPoseInto: (id: string, out: Pose) => boolean };
    const pose: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    const at = (id: string): { x: number; y: number } => {
      expect(r.entityPoseInto(id, pose)).toBe(true);
      return { x: pose.x, y: pose.y };
    };
    const gapOf = (): number => {
      const a = at(A);
      return Math.max(Math.hypot(at(B).x - a.x, at(B).y - a.y), Math.hypot(at(C).x - a.x, at(C).y - a.y));
    };
    // The owner flies A on for 8 s under thrust; the pack keeps with it all the way.
    const start = at(A);
    let maxGap = 0;
    for (let i = 0; i < 160; i++) {
      harness.sendThrust(client);
      await harness.advance(50);
      if (i % 5 === 4) maxGap = Math.max(maxGap, gapOf());
    }
    const end = at(A);
    const travelled = Math.hypot(end.x - start.x, end.y - start.y);
    expect(travelled, 'A flew a long way under its pilot').toBeGreaterThan(PACK_RADIUS);
    console.log(`[squad pack] A flew ${travelled.toFixed(0)} u, max member gap ${maxGap.toFixed(0)} u (limit ${PACK_RADIUS})`);
    expect(maxGap, `members within ${PACK_RADIUS} u of A the whole way (A flew ${travelled.toFixed(0)} u)`)
      .toBeLessThanOrEqual(PACK_RADIUS);

    client.send('input', { type: 'input', tick: 0, thrust: false, turnLeft: false, turnRight: false });
    await harness.disconnectClient(client);
  }, 90_000);

  it('a member under fire from an attacker it cannot see keeps following its leader', async () => {
    const pid = randomUUID();
    // Far from the sector centre, so the AI pilots' idle orbit (round the
    // origin) is nowhere near the pack.
    const { room, client, ids } = await parkHulls(pid, [[6000, 0], [6000, -250]]);
    const [L, M] = ids as [string, string];
    const internals = room._internals;
    const fleet = internals.fleet;
    expect(fleet.formSquad(pid, [L, M])).not.toBeNull();
    await harness.advance(300);
    expect(internals.aiBrainOf(M)?.getFlockLeaderId?.()).toBe(L);

    // Shot by a ship that is not in its view (it left / is out of sight):
    // M is in a fight with nothing to shoot.
    internals.applyDamage(M, 'gone-attacker', 1);
    // The whole squad moves 1400 u north (short of a boosted leg).
    expect(fleet.applyOrder(pid, [L, M], { kind: 'move', x: 6000, y: 1400 }).length).toBe(2);
    const r = room as unknown as { entityPoseInto: (id: string, out: Pose) => boolean };
    const pose: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    const at = (id: string): { x: number; y: number } => {
      expect(r.entityPoseInto(id, pose)).toBe(true);
      return { x: pose.x, y: pose.y };
    };
    let maxGap = 0;
    for (let i = 0; i < 40; i++) {
      await harness.advance(250);
      const l = at(L);
      const m = at(M);
      maxGap = Math.max(maxGap, Math.hypot(m.x - l.x, m.y - l.y));
    }
    const brain = internals.aiBrainOf(M)!;
    expect(brain.getTargetId?.() ?? null, 'nothing to shoot').toBeNull();
    expect(brain.getFlockLeaderId?.(), 'still in the pack').toBe(L);
    expect(at(L).y, 'the leader went north').toBeGreaterThan(1000);
    expect(at(M).y, 'M went north with it (not off on the idle orbit)').toBeGreaterThan(1000);
    expect(maxGap, `M kept within ${PACK_RADIUS} u of its leader`).toBeLessThanOrEqual(PACK_RADIUS);

    await harness.disconnectClient(client);
  }, 90_000);

  it('an Escort squad turns on a ship that shoots the escorted ship; its zone follows the escorted ship', async () => {
    const pid = randomUUID();
    const pidB = randomUUID();
    const { room, state, client: owner, ids } = await parkHulls(pid, [[0, 0], [300, 0], [-2500, 0], [0, 600]]);
    const [E1, E2, OUT, P] = ids as [string, string, string, string];
    const internals = room._internals;
    const fleet = internals.fleet;
    const targetOf = (id: string): string | null => internals.aiBrainOf(id)?.getTargetId?.() ?? null;
    // The owner flies P.
    owner.send('pilot_ship', { type: 'pilot_ship', shipId: P });
    owner.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);
    expect(state.ships.get(P)?.isActive, 'the owner flies P').toBe(true);
    expect(fleet.formSquad(pid, [E1, E2])).not.toBeNull();
    // The client names its own flown ship by its playerId.
    owner.send('set_mode', { type: 'set_mode', shipIds: [E1, E2], mode: 'escort', escortId: pid });
    await harness.advance(600);
    for (const id of [E1, E2]) {
      expect(fleet.escortTargetOf(id), `${id} escorts P`).toBe(P);
      const b = internals.aiBrainOf(id)!;
      expect(b.getFlockLeaderId?.(), `${id} packs on P`).toBe(P);
    }
    // The guard zone sits on P.
    const r = room as unknown as { entityPoseInto: (id: string, out: Pose) => boolean };
    const pose: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    expect(r.entityPoseInto(P, pose)).toBe(true);
    const post = internals.aiBrainOf(E1)!;
    expect(Math.hypot((post.getGuardPostX?.() ?? NaN) - pose.x, (post.getGuardPostY?.() ?? NaN) - pose.y)).toBeLessThan(1);

    // B flies near P and shoots P.
    const clientB = await harness.connectActive(pidB, { shipKind: 'fighter', spawnX: 500, spawnY: 900 });
    await harness.advance(300);
    for (const id of [E1, E2, OUT]) expect(targetOf(id), `${id} starts with no target`).toBeNull();
    // The owner's own fire on P is no hostile act.
    internals.applyDamage(pid, E1, 1);
    await harness.advance(300);
    for (const id of [E1, E2]) expect(targetOf(id)).toBeNull();
    internals.applyDamage(pid, pidB, 1);
    await harness.advance(500);
    expect(targetOf(E1), 'escort 1 turns on B').toBe(pidB);
    expect(targetOf(E2), 'escort 2 turns on B').toBe(pidB);
    expect(targetOf(OUT), 'a hull not escorting P stays out of it').toBeNull();

    await harness.disconnectClient(clientB);
    await harness.disconnectClient(owner);
  }, 90_000);
});
