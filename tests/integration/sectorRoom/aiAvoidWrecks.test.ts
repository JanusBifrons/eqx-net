/**
 * AI pilots steer around wreck pieces (take 11 "ghost ship", 2026-11-14).
 *
 * Fleet-melee take 11: a ship flying through the melee caught a slowed wreck
 * piece of a dead small ship on its shield bubble and carried it along for
 * 5-15 s, the piece ~58-75 u from the ship's centre at nearly the ship's
 * speed: a dead hull flying in formation, read as a live ship. Gunfire
 * shoving was fixed by the line-of-fire hold; this is the other half: the
 * brain's hull avoidance now reads the room's wreck pieces (`view.debris`)
 * and clears them by `hullClearance`, as it clears a ship.
 *
 * Room: two sides of three AI-flown fighters (endless hull and nerve) fight
 * across a field of pieces from eighteen fighters killed at the start (sub-cap
 * break-up on, game speed 4). Over 20 game seconds no piece may travel
 * ALONGSIDE a live ship (inside 1.5 × the pair's clearance at a relative
 * speed under 30 u/s) for more than 1 s, and at most half as many
 * piece-ship pairs touch as with the brains blind to debris (the control
 * arm, `setAiWreckAvoid(false)`, printed as the before number). This room
 * does not reproduce a >1 s carry on its own (worst 0.42 s blind): the
 * touch count is what fails without the fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { hullClearance } from '../../../src/core/ai/tactics/manoeuvre.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

const WRECK_KIND = 4;
const SPEED = 4;
const WINDOW_TICKS = 20 * 60;
const ALONGSIDE_CLEAR_MUL = 1.5;
const ALONGSIDE_REL_SPEED = 30;
const MAX_ALONGSIDE_S = 1;

interface Result { worstS: number; over: number; pairsSeen: number; pieces: number; touches: number; maxPieceSpeed: number }

describe('SectorRoom integration — AI pilots steer around wreck pieces', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  async function melee(avoid: boolean): Promise<Result> {
    const A = 'fighter';
    const B = 'patrol-fighter';
    const poses = [
      { kind: A, x: -3000, y: -300, angle: -Math.PI / 2 },
      { kind: A, x: -3000, y: 0, angle: -Math.PI / 2 },
      { kind: A, x: -3000, y: 300, angle: -Math.PI / 2 },
      { kind: B, x: 3000, y: -300, angle: Math.PI / 2 },
      { kind: B, x: 3000, y: 0, angle: Math.PI / 2 },
      { kind: B, x: 3000, y: 300, angle: Math.PI / 2 },
    ];
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [],
      dronePoses: poses.map((p) => ({ ...p, hullExposed: false })),
      defaultSpawnX: 0, defaultSpawnY: 20_000, subcapWrecks: true, timeScale: SPEED,
    });
    // A PENDING observer creates the room; the AI only targets ACTIVE hulls.
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom() as unknown as SectorRoom & {
      aiController: { markHostile(id: string, o: string, t: number): void; getBehaviour(id: string): unknown };
      serverTick: number;
    };
    const int = room._internals;
    int.setAiWreckAvoid(avoid);
    const ships = [...int.swarmRegistry.all()].filter((r) => r.kind === 1);
    const sideA = ships.filter((r) => r.shipKind === A).map((r) => r.id);
    const sideB = ships.filter((r) => r.shipKind === B).map((r) => r.id);
    for (const id of [...sideA, ...sideB]) {
      int.swarmHealth.set(id, 1e9);
      (room.aiController.getBehaviour(id) as HostileDroneBehaviour).setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    }
    for (const a of sideA) for (const b of sideB) {
      room.aiController.markHostile(a, b, room.serverTick);
      room.aiController.markHostile(b, a, room.serverTick);
    }
    // The debris field between the two lines, on each pair's approach row:
    // eighteen dead fighters.
    let dead = 0;
    for (const x of [-1500, -900, -300, 300, 900, 1500]) for (const y of [-300, 0, 300]) {
      expect(int.spawnTestDrone(`dead-${dead++}`, x, y, 'fighter')).toBe(true);
    }
    await harness.advance(50);
    for (let i = 0; i < dead; i++) int.applyDamage(`dead-${i}`, 'shooter-x', 1e7);
    await harness.advance(50);
    const live = [...sideA, ...sideB];
    const pad = new Map(live.map((id) => {
      const k = getShipKind(ships.find((r) => r.id === id)!.shipKind as never);
      return [id, { r: k.radius, pad: shipTuning(k).shieldPad }] as const;
    }));
    const runStart = new Map<string, number>();
    const seen = new Set<string>();
    let worst = 0;
    const overPairs = new Set<string>();
    let pieceCount = 0;
    const touched = new Set<string>();
    let maxPieceSpeed = 0;
    const t0 = room.serverTick;
    while (room.serverTick - t0 < WINDOW_TICKS) {
      await harness.advance(20);
      const tick = room.serverTick;
      const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
      pieceCount = Math.max(pieceCount, pieces.length);
      for (const p of pieces) {
        const ps = int.wreckState(p.id);
        if (!ps) continue;
        maxPieceSpeed = Math.max(maxPieceSpeed, Math.hypot(ps.vx, ps.vy));
        for (const s of live) {
          const ss = int.wreckState(s);
          if (!ss) continue;
          const key = `${p.id}|${s}`;
          const sz = pad.get(s)!;
          const clear = hullClearance(sz.r, p.radius, sz.pad);
          const d = Math.hypot(ps.x - ss.x, ps.y - ss.y);
          if (d < sz.r + sz.pad + p.radius + 5) touched.add(key);
          const near = d < ALONGSIDE_CLEAR_MUL * clear;
          const slow = Math.hypot(ps.vx - ss.vx, ps.vy - ss.vy) < ALONGSIDE_REL_SPEED;
          if (near && slow) {
            seen.add(key);
            if (!runStart.has(key)) runStart.set(key, tick);
            const dur = (tick - runStart.get(key)!) / 60;
            if (dur > worst) worst = dur;
            if (dur > MAX_ALONGSIDE_S) overPairs.add(key);
          } else {
            runStart.delete(key);
          }
        }
      }
    }
    return { worstS: worst, over: overPairs.size, pairsSeen: seen.size, pieces: pieceCount, touches: touched.size, maxPieceSpeed };
  }

  const line = (tag: string, r: Result): string =>
    `[aiAvoidWrecks] ${tag} worst alongside ${r.worstS.toFixed(2)} s, pairs over 1 s ${r.over}, pairs ever alongside ${r.pairsSeen}, pieces ${r.pieces}, piece-ship pairs touched ${r.touches}, fastest piece ${r.maxPieceSpeed.toFixed(0)} u/s`;

  it('after 20 s of fighting no wreck piece has travelled alongside a live ship for more than 1 s', { timeout: 120_000 }, async () => {
    // Control arm first (the before number): the same room with no debris in
    // the brains' view.
    const off = await melee(false);
    console.log(line('OFF', off));
    await harness!.cleanup();
    harness = undefined;
    const on = await melee(true);
    const msg = `${line('ON', on)} | ${line('OFF', off)}`;
    console.log(line('ON', on));
    expect(on.pieces, msg).toBeGreaterThanOrEqual(36);
    expect(on.over, msg).toBe(0);
    expect(on.worstS, msg).toBeLessThanOrEqual(MAX_ALONGSIDE_S);
    // The pilots steer round the pieces: far fewer ever touch a bubble
    // (2026-11-14, blind → avoiding: 47 → 13, 25 → 9, 38 → 11 pairs).
    expect(on.touches, msg).toBeLessThanOrEqual(0.5 * off.touches);
  });
});
