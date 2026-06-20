/**
 * WS-E #22 — roaming squads avoid active-combat sectors.
 *
 * USER REPORT (on-device): "Roaming ships should avoid sectors with active
 * combat … combat within 5 minutes."
 *
 * pickRoamGoal was combat-blind. The RecentCombatLog (5-min sliding window)
 * already exists per room; this wires the director's roamStep to skip any live
 * neighbour whose room reports recent combat (recentCombat() != null), and to
 * HOLD when every neighbour is unsafe.
 *
 * This integration test boots a real 3-sector galaxy and stubs ONE neighbour's
 * recentCombat to look "in combat", then watches where a roaming squad drifts. On
 * current code the roamer would happily hop into the combat sector; with the fix
 * it routes to the safe neighbour instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import type { RecentCombat } from '../../../src/shared-types/galaxySnapshot.js';

describe('SectorRoom integration — roaming avoids active-combat sectors (WS-E #22)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('a roaming squad drifts to the SAFE neighbour, not the active-combat one', async () => {
    // greenfall (entry) neighbours emerald-span + verdance in this boot set.
    // Flag emerald-span as in active combat → the roamer must pick verdance.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span', 'verdance'],
      botCount: 8,
      seed: 11,
      director: { roamIntervalMs: 800, hopTravelMs: 30 },
    });

    // Stub emerald-span as "in combat within the window" (the room owns the real
    // RecentCombatLog; we override its summary to drive the director's predicate).
    const combatSummary: RecentCombat = {
      shipsDestroyed: 3,
      structuresDestroyed: 0,
      lastEventMs: Date.now(),
    };
    h.getRoom('emerald-span').recentCombat = () => combatSummary;

    // The squad gathers at its home entry (greenfall) first.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      6000,
      'squad gathered at its home edge',
    );

    // Then it roams. With emerald-span flagged in-combat, it must drift into the
    // SAFE neighbour (verdance), never the combat one (emerald-span).
    await h.waitUntil(
      () => h!.director.snapshot().perSector['verdance']!.bots > 0,
      8000,
      'roaming squad drifted to the safe neighbour (verdance)',
    );
    expect(h.director.snapshot().perSector['verdance']!.bots).toBeGreaterThan(0);

    // Across MANY roam decisions (roamIntervalMs 800, ~10 s window ⇒ ~12 picks),
    // an UN-avoided roamer would land in emerald-span with overwhelming
    // probability (~1 - 0.5^12). With avoidance it NEVER does — poll the whole
    // window and assert the combat sector stays empty.
    let everEnteredCombat = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (h.director.snapshot().perSector['emerald-span']!.bots > 0) {
        everEnteredCombat = true;
        break;
      }
      await h.advance(200);
    }
    expect(everEnteredCombat).toBe(false);
  }, 40_000);
});
