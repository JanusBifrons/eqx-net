/**
 * Scene-level check (film take 12, 2026-11-14): AI-flown fighters hovered
 * nose-down doing nothing for 10–16 s in the dogfight and fleet-melee scenes,
 * and the melee had no robot kills, once one mass per ship kind made every
 * AI-flown hull half as heavy. This runs the `dogfight-3v3` perf scene as
 * filmed (on sight, nobody marked hostile, morale die live) for 30 s of game
 * time and checks that every ship keeps moving while an enemy is alive; kills
 * are logged. Hover = under `HOVER_FRAC` of the ship's
 * cruise speed; the longest such stretch per ship is logged and gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { PERF_SCENES } from '../../../src/shared-types/perf/perfScenes.js';

const SAMPLE_MS = 50;
const SCENE_MS = 30_000;
/** A ship slower than this share of its cruise speed is hovering. */
const HOVER_FRAC = 0.15;
/** Longest hover allowed while an enemy is alive (game ms). */
const MAX_HOVER_MS = 3000;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
  };
  aiController: { getBehaviour(id: string): unknown };
  serverTick: number;
}

let harness: SectorTestHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('SectorRoom integration — AI pilots keep moving in a filmed scene', () => {
  it('dogfight-3v3, 30 s as filmed: no ship hovers > 3 s while an enemy is alive, kills logged', { timeout: 120_000 }, async () => {
    const scene = PERF_SCENES.find((s) => s.id === 'dogfight-3v3')!;
    harness = await bootSectorTestServer({
      ...scene.room, sectorKey: null, defaultSpawnX: 0, defaultSpawnY: -20_000,
    } as never);
    await harness.connectActive(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;
    let ships: Array<{ id: string; shipKind?: string }> = [];
    for (let i = 0; i < 40 && ships.length < 6; i++) {
      await harness.advance(SAMPLE_MS);
      ships = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
    }
    expect(ships.length).toBe(6);
    const side = (r: { shipKind?: string }): number => (r.shipKind === 'fighter' ? 0 : 1);
    const cruise = new Map<string, number>();
    for (const r of ships) cruise.set(r.id, (room.aiController.getBehaviour(r.id) as HostileDroneBehaviour).getCruiseSpeed());
    const prev = new Map<string, { x: number; y: number }>();
    const hoverStart = new Map<string, number>();
    const longest = new Map<string, number>();
    for (const r of ships) { prev.set(r.id, room._internals.swarmPose(r.id)!); longest.set(r.id, 0); }
    let prevTick = room.serverTick;
    const tick0 = room.serverTick;
    while (room.serverTick - tick0 < (SCENE_MS / 1000) * 60) {
      await harness.advance(SAMPLE_MS);
      const dt = (room.serverTick - prevTick) / 60;
      prevTick = room.serverTick;
      if (dt <= 0) continue;
      const nowMs = ((room.serverTick - tick0) / 60) * 1000;
      const alive = [0, 0];
      for (const r of ships) if (room._internals.swarmPose(r.id)) alive[side(r)]!++;
      for (const r of ships) {
        const p = room._internals.swarmPose(r.id);
        if (!p) { hoverStart.delete(r.id); continue; }
        const q = prev.get(r.id)!;
        const speed = Math.hypot(p.x - q.x, p.y - q.y) / dt;
        prev.set(r.id, p);
        const enemies = alive[1 - side(r)]!;
        if (enemies > 0 && speed < HOVER_FRAC * cruise.get(r.id)!) {
          if (!hoverStart.has(r.id)) hoverStart.set(r.id, nowMs);
          longest.set(r.id, Math.max(longest.get(r.id)!, nowMs - hoverStart.get(r.id)!));
        } else {
          hoverStart.delete(r.id);
        }
      }
    }
    const dead = ships.filter((r) => room._internals.swarmPose(r.id) === null);
    const deadBlue = dead.filter((r) => side(r) === 0).length;
    const deadRed = dead.length - deadBlue;
    const hovers = ships.map((r) => `${r.shipKind}:${(longest.get(r.id)! / 1000).toFixed(1)}s`).join(' ');
    console.log(`[keepsMoving] dogfight-3v3 30s: kills drones=${deadBlue} robots=${deadRed} longestHover ${hovers}`);
    for (const r of ships) expect(longest.get(r.id)!, `${r.shipKind} ${r.id} hovered`).toBeLessThanOrEqual(MAX_HOVER_MS);
    // Kills are logged, not gated: the pre-one-mass tip (30384eb1) measured
    // 0 and 3 robot kills in two runs, this branch 3 and 2.
  });
});
