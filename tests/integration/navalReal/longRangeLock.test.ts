/**
 * Real-scale naval ranges: can a PLAYER battleship see, lock and hit targets
 * 30 km away? It sees them, but (owner 2026-11-21, "for now") nothing locks
 * past lock range (`LOCK_TUNING.maxLockRange`, ~1 km hull to hull), so it
 * neither locks nor fires on them. (The real-scale-ranges doc listed "entity interest" as a gap:
 * ships ride ±3,072 u cells, so "a pilot can't see or lock most targets 30 km
 * out". This test is the evidence that interest does not stop it.)
 *
 * 1. Seeing: an NPC capital, an NPC fighter and a structure 30 km out ride the
 *    binary swarm channel to the pilot out of interest (every 6 ticks while
 *    awake, the 1 Hz full refresh while parked); another player's ship rides
 *    every snapshot (~20 Hz).
 * 2. Locking: past lock range the server refuses every one of them: the
 *    shared lock-time rule says Infinity whatever the 16"'s reach, and no lock
 *    completes, even under `instantLock`.
 * 3. Firing: with no lock the main battery refuses to fire (#19).
 *
 * Runs only with the switch on: `pnpm test:naval-real`. `instantLock` skips
 * the ~17 s heavy-gun lock time (it still refuses a lock `lockSeconds` can't make).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from '../sectorRoom/harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWeapon, weaponAutoFireRange } from '../../../src/core/combat/WeaponCatalogue.js';
import { NAVAL_RANGE } from '../../../src/shared-types/combat/navalRange.js';
import { encodeAim } from '../../../src/core/combat/manualAim.js';
import { lockSeconds } from '../../../src/core/combat/lockTime.js';
import { LOCK_TUNING } from '../../../src/shared-types/combat/lockProfile.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { SWARM_HEADER_BYTES, SWARM_RECORD_BYTES } from '../../../src/shared-types/swarmWireFormat.js';

const RANGE = 30_000;

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number; c?: 1 }> }

/** World bearing (ship-angle convention, forward = (-sin b, cos b)) of the offset (x, y). */
const bearingTo = (x: number, y: number): number => Math.atan2(-x, y);

describe.runIf(NAVAL_RANGE === 'real')('real naval ranges — a player battleship sees targets 30 km out but cannot lock them', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('NPC capital, NPC fighter, structure and player at 30 km: seen, but none locks (past lock range) and the main battery holds fire', { timeout: 60_000 }, async () => {
    const xl = getWeapon('naval_xl');
    expect(weaponAutoFireRange(xl), 'the switch is on: the 16" reaches 38.7 km').toBeGreaterThan(38_000);

    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true,
      asteroidConfig: [],
      dronePoses: [
        { kind: 'battleship', x: 0, y: RANGE, angle: Math.PI / 2 },
        { kind: 'fighter', x: 4_000, y: RANGE, angle: 0 },
      ],
      prebuiltStructures: [{ kind: 'solar', x: -4_000, y: RANGE }],
    });
    const pid = randomUUID();
    const otherPid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'battleship', spawnX: 0, spawnY: 0, initialHull: 1_000_000, groupMode: 'manual', instantLock: true,
    });
    await harness.connectActive(otherPid, { shipKind: 'battleship', spawnX: 8_000, spawnY: RANGE });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internal = room._internals;

    const recs = [...internal.swarmRegistry.all()];
    const bs = recs.find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    const ftr = recs.find((r) => r.kind === 1 && r.shipKind === 'fighter')!;
    const st = recs.find((r) => r.kind === 2)!;
    expect(bs && ftr && st, 'the room has the three swarm targets').toBeTruthy();

    // ── 1. Seeing: every binary swarm record per target (server tick + sleep
    //    bit) and every snapshot state of the other player.
    const recv = new Map<number, Array<{ tick: number; asleep: boolean }>>([[bs.entityId, []], [ftr.entityId, []], [st.entityId, []]]);
    let otherSeen = 0;
    let groups: SnapGroups[] | undefined;
    cr.onMessage('swarm', (buf: Uint8Array) => {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
      const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const tick = v.getUint32(4, true);
      for (let o = SWARM_HEADER_BYTES; o + SWARM_RECORD_BYTES <= u8.byteLength; o += SWARM_RECORD_BYTES) {
        recv.get(v.getUint16(o, true))?.push({ tick, asleep: (v.getUint8(o + 3) & 1) !== 0 });
      }
    });
    cr.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const s of Object.values(snap.states ?? {})) {
        if (s.playerId === pid) groups = s.groups;
        if (s.playerId === otherPid) otherSeen++;
      }
    });
    harness.sendThrust(cr); // wake the sector so snapshots flow, then let go
    cr.send('input', { type: 'input', tick: 0, thrust: false, turnLeft: false, turnRight: false });
    const WINDOW_MS = 3_000;
    await harness.advance(WINDOW_MS);
    console.log('[longRange] receipts (tick:asleep) — capital', recv.get(bs.entityId)!.map((r) => `${r.tick}:${+r.asleep}`).join(' '),
      '| fighter', recv.get(ftr.entityId)!.length, '| structure', recv.get(st.entityId)!.length,
      '| player snapshots/s', otherSeen / (WINDOW_MS / 1000));
    // Out of interest, an AWAKE drone ships every 6 ticks (~10 Hz; a catch-up
    // update that steps past the decimation tick makes a 12-tick gap); once asleep
    // (parked: these are peaceful) it ships on the 1 Hz full refresh (a skipped refresh tick doubles it). Either way
    // the client holds a live pose of a capital and a fighter 30 km out.
    for (const [label, id] of [['capital', bs.entityId], ['fighter', ftr.entityId]] as const) {
      const r = recv.get(id)!;
      expect(r.length, `${label} 30 km out: poses arrive`).toBeGreaterThan(2);
      for (let i = 1; i < r.length; i++) {
        const gap = r[i]!.tick - r[i - 1]!.tick;
        expect(gap, `${label}: gap ${r[i - 1]!.tick}→${r[i]!.tick}`).toBeLessThanOrEqual(r[i - 1]!.asleep ? 120 : 12);
      }
    }
    // A sleeping structure out of interest rides every 5th full refresh (5 s);
    // it doesn't move, and its first pose arrives on join.
    expect(otherSeen / (WINDOW_MS / 1000), 'another player 30 km out rides every snapshot (~20 Hz)').toBeGreaterThan(10);

    // ── 2. Locking: hold the main battery's line (16", reach 38.7 km) on each
    //    target in turn, as the client's `guideLock` does. Past lock range
    //    nothing locks, whatever the reach (owner 2026-11-21).
    const main = 'main';
    const poseCache = (room as unknown as { shipPoseCache: Map<string, { x: number; y: number; vx: number; vy: number }> }).shipPoseCache;
    const poseOf = (id: string): { x: number; y: number; vx: number; vy: number } => poseCache.get(id)!;
    const locks = (room as unknown as{ locks: { players: Map<string, { sensor: number; groups: Array<{ id: string; refSize: number; tracking: number; absRange: boolean; reach: number }> }> } }).locks;
    const mainGeo = locks.players.get(pid)!.groups.find((g) => g.id === main)!;
    const sensor = locks.players.get(pid)!.sensor;
    const selfR = getShipKind('battleship').radius;
    const holdLine = (key: string, x: number, y: number): void => {
      const p = poseOf(pid);
      cr.send('lock_track', { type: 'lock_track', groupId: main, target: key, b: encodeAim(bearingTo(x - p.x, y - p.y)) });
    };
    const lockOf = (key: string) => groups?.find((g) => g.id === main)?.l.find((l) => l.t === key);
    /** The shared lock-time rule for this group on a target of `signature` at (x, y). */
    const lockSecsAt = (signature: number, x: number, y: number): number => {
      const p = poseOf(pid);
      return lockSeconds({
        refSize: mainGeo.refSize, tracking: mainGeo.tracking, absRange: mainGeo.absRange, reach: mainGeo.reach,
        sensor, pilotSpeed: 1, signature, dx: x - p.x, dy: y - p.y, dvx: -p.vx, dvy: -p.vy, hullRadii: selfR + signature,
      }, LOCK_TUNING);
    };
    expect(mainGeo.reach, 'the 16" reaches past 30 km').toBeGreaterThan(RANGE);
    for (const [label, key, x, sig] of [
      ['capital', `s:${bs.entityId}`, 0, getShipKind('battleship').radius],
      ['structure', `s:${st.entityId}`, -4_000, st.radius],
      ['fighter', `s:${ftr.entityId}`, 4_000, getShipKind('fighter').radius],
      ['player', `p:${otherPid}`, 8_000, getShipKind('battleship').radius],
    ] as const) {
      expect(lockSecsAt(sig, x, RANGE), `${label} 30 km out: past lock range`).toBe(Infinity);
      holdLine(key, x, RANGE);
      await harness.advance(600);
      expect(lockOf(key)?.s, `${label} 30 km out: never locked (instantLock too)`).not.toBe(2);
    }

    // ── 3. Firing: no lock, so the main battery holds fire (#19).
    let accepted = 0;
    let rejected = 0;
    cr.onMessage('hit_ack', (m: { rejected?: boolean }) => { if (m.rejected) rejected++; else accepted++; });
    for (let shot = 0; shot < 4; shot++) {
      cr.send('fire', { type: 'fire', tick: room._internals.serverTick, clientShotId: `s${shot}`, weapon: 'naval_xl', dirAngle: 0, slotId: main });
      await harness.advance(250);
    }
    expect(accepted, 'no shot without a lock').toBe(0);
    expect(rejected, 'the fire claims were refused').toBeGreaterThan(0);
  });
});
