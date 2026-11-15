/**
 * Morale's burst trigger counts HULL damage, not hits the shield took
 * (showcase review 2026-11-14, fleet melee). Measured in the showcase-melee
 * scene: 28 Burst triggers in 44 s, most on ships at 100 % hull with their
 * shield still up; three of the four Flee results (a scout and two fighters)
 * were rolled at full hull. The damage path fed every hit into the burst
 * window as a fraction of max HULL, so a ship whose shield soaked 20 % of its
 * hull's worth in 2 s rolled as if it had lost a fifth of its hull.
 *
 * A shield absorbs a whole hit (no spill, `applyLayeredDamage`), so a hit
 * whose layer is the shield leaves the hull, and the burst window, untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number }> };
    swarmHealth: Map<string, number>;
  };
  aiController: { getBehaviour(id: string): unknown };
  serverTick: number;
  applyDamage: (t: string, s: string, damage: number) => void;
  swarmShield: Map<string, number>;
}

type Brain = { _morale: { windowDamageFrac(tick: number): number } };

describe('SectorRoom integration — morale burst counts hull damage only', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('hits the shield soaks leave the burst window empty; hull hits fill it', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [{ kind: 'fighter', x: 0, y: 0, angle: 0, hullExposed: false }],
      defaultSpawnX: 0,
      defaultSpawnY: 9000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;
    const id = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1)!.id;
    const brain = room.aiController.getBehaviour(id) as Brain;
    const k = getShipKind('fighter');
    const shield0 = room.swarmShield.get(id) ?? k.shieldMax ?? 0;
    expect(shield0, 'the fighter starts shielded').toBeGreaterThan(0.25 * k.maxHealth);

    // 25 % of max hull, all on the shield: the hull is untouched.
    room.applyDamage(id, 'someone', 0.25 * k.maxHealth);
    expect(room._internals.swarmHealth.get(id)).toBe(k.maxHealth);
    expect(brain._morale.windowDamageFrac(room.serverTick), 'a shield hit is not hull damage').toBe(0);

    // Shield down: the next hit lands on the hull and counts.
    room.swarmShield.set(id, 0);
    room.applyDamage(id, 'someone', 0.25 * k.maxHealth);
    expect(room._internals.swarmHealth.get(id)).toBeLessThan(k.maxHealth);
    expect(brain._morale.windowDamageFrac(room.serverTick)).toBeCloseTo(0.25, 5);
  });
});
