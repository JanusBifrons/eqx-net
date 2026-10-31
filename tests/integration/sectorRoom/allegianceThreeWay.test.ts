/**
 * Allegiances P0 (plan peppy-jumping-pinwheel) — a ROBOT and a DRONE fight each
 * other in a real room with NO player provocation.
 *
 * Pre-P0 there was exactly one AI side: the drone brain only ever saw players
 * and player structures (`AiWorldView` had no other-swarm slice), so two AI
 * entities parked beside each other never fought. This drives the full server
 * path — per-tick swarm-combatant view → brain on-sight stance → fire resolver
 * → `applyDamage` → `damage` broadcast — and FAILS on pre-P0 code (no damage
 * event between the two AI entities ever arrives).
 *
 * Also locks the server-side `npcOnly` gate: a forged join asking to PILOT a
 * robot kind gets the default kind instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';

describe('SectorRoom integration — allegiances: robots vs drones (P0)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      dronePoses: [
        // Fighter (drones) facing +x, robot (robots) facing -x, 300 u apart.
        { kind: 'fighter', x: -150, y: 0, angle: -Math.PI / 2 },
        { kind: 'robot-square', x: 150, y: 0, angle: Math.PI / 2 },
      ],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  // Timeout covers room boot + join (infrastructural, ~13 s worst case on a
  // loaded Windows box); the fight itself is deadline-bounded below.
  it('a robot and a drone damage each other unprovoked', { timeout: 40_000 }, async () => {
    const p1 = randomUUID();
    // A PENDING (not-yet-active) observer: it creates the room + receives
    // broadcasts, but the AI only targets ACTIVE hulls — so the only possible
    // fight is robot vs drone.
    const cr = await harness.connectAs(p1);

    const aiHits: DamageEvent[] = [];
    cr.onMessage('damage', (msg: DamageEvent) => {
      if (msg.targetId !== p1 && msg.shooterId !== p1) aiHits.push(msg);
    });
    harness.sendThrust(cr);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && aiHits.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      aiHits.length,
      'no AI-vs-AI damage event: the robot and drone never fought (two-sided AI is broken)',
    ).toBeGreaterThan(0);
    expect(aiHits[0]!.targetId).not.toBe(aiHits[0]!.shooterId);
  });

  it('a forged join cannot PILOT an npcOnly (robot) kind', { timeout: 30_000 }, async () => {
    const p2 = randomUUID();
    await harness.connectActive(p2, { shipKind: 'robot-square' });
    const server = harness.getServerRoom();
    const kinds = [...(server?.state.ships.values() ?? [])].map((s) => s.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('robot-square');
  });
});
