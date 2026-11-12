/**
 * Hostile clip review, 2026-11-12 (`showcase-capital-duel`, clip
 * capital-turrets 13.4-14.4 s): an NPC battleship fires 16" shells at a
 * pilot's heavy cruiser parked (Spectate) off its beam. "The first salvo hits
 * in EMPTY SPACE": a 2800 damage number and an explosion ~600 px (≈ 3,000 u at
 * zoom 0.18) short of the cruiser, then one shell flies on through that
 * explosion and scores 4200 on the real hull.
 *
 * Root cause (measured here): a PILOT's ship (active, or its parked hull,
 * which reuses the same sweep since #491) with its shield up was swept as a
 * circle of `kind.radius + shieldPad`. For a capital `radius` is half the hull's
 * LENGTH (heavy cruiser: 2,184 u) but its beam is only 227 u either side of the
 * keel, so a broadside shell detonated ~1,980 u off the side of the hull. The
 * designed capital shield follows the hull (`shipShieldColliderDesc`: the hull
 * rounded out by the pad; NPC capitals already refine every hit to the hull,
 * `capitalHits.ts`). The first hit took the shield to 0 (no spillover), the
 * hull became the shape, so the next shell flew through the old circle and hit
 * the hull: the "shell through the explosion" was a second shell of the salvo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shieldVisualRadius, shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const HC = getShipKind('heavy-cruiser');
/** Half the cruiser's beam plus its shield pad: the farthest off the keel a
 *  broadside hit on the designed (hull-hugging) shield can land. */
const SHIELD_REACH = shieldVisualRadius(HC) + shipTuning(HC).shieldPad;
/** Shell start: well outside even the old 2,204 u circle. */
const STANDOFF = HC.radius + 1500;

describe('SectorRoom integration — a shell hits a capital pilot\'s shield at the hull, not in empty space', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true,
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  for (const parked of [true, false]) {
    it(`a broadside shell on a ${parked ? 'parked' : 'flown'} shield-up heavy cruiser lands at its side`, { timeout: 30_000 }, async () => {
      const pid = randomUUID();
      const cr = (await harness.connectActive(pid, {
        shipKind: 'heavy-cruiser', spawnX: 0, spawnY: 0, initialHull: 1_000_000,
      })) as ClientRoom<SectorState>;
      const server = harness.getServerRoom() as unknown as SectorRoom;
      let shipId = '';
      for (const [, s] of server.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
      expect(shipId).not.toBe('');
      expect(server.state.ships.get(shipId)!.shield).toBeGreaterThan(0);
      const hits: DamageEvent[] = [];
      cr.onMessage('damage', (e: DamageEvent) => { if (e.targetId === pid || e.targetId === shipId) hits.push(e); });

      let pose: { x: number; y: number; angle: number };
      if (parked) {
        cr.send('spectate', { type: 'spectate' });
        await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');
        const p = (server as unknown as { lingeringPoseCache: Map<string, { x: number; y: number; angle: number }> })
          .lingeringPoseCache.get(shipId)!;
        pose = { x: p.x, y: p.y, angle: p.angle };
      } else {
        const p = (server as unknown as { shipPoseCache: Map<string, { x: number; y: number; angle: number }> })
          .shipPoseCache.get(pid)!;
        pose = { x: p.x, y: p.y, angle: p.angle };
      }
      // The hull's long axis is local +y; its beam is local x. Fire along
      // local +x straight at the keel from STANDOFF off the side.
      const bx = Math.cos(pose.angle);
      const by = Math.sin(pose.angle);
      const speed = 3000;
      server._internals.spawnTestProjectile('test-shooter', pose.x - bx * STANDOFF, pose.y - by * STANDOFF, bx * speed, by * speed, 'laser', 50);
      await waitUntil(() => hits.length > 0, 5000, 'the shell hits the cruiser');
      const h = hits[0]!;
      expect(h.hitLayer).toBe('shield');
      // Distance of the impact from the keel, measured across the beam.
      const across = Math.abs(((h.hitX ?? NaN) - pose.x) * bx + ((h.hitY ?? NaN) - pose.y) * by);
      expect(across, `impact ${across.toFixed(0)} u off the keel; the hull's side is ${SHIELD_REACH.toFixed(0)} u`)
        .toBeLessThanOrEqual(SHIELD_REACH + 10);
    });
  }
});
