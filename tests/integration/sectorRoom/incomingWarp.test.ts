/**
 * Incoming-warp HUD feed — the "sector incoming indicator" (Phase-4 P0).
 *
 * Bug (user's words, 3rd failed attempt): the incoming banner ALWAYS reads
 * "Nothing incoming" even while ships warp into the player's sector. Diagnostic
 * `diag/captures/2026-06-13T15-48-18Z-84rbl1/` shows 8 remote `warp_in` arrivals
 * and ZERO warnings shown.
 *
 * Root cause: the server only ever broadcast a `warp_warning` from the wave
 * step's FINAL-approach branch (`finalApproach > 0 && !squad.warned`). A ROAMING
 * (neutral, unassigned) squad — or a lone fighter, or a player — that drifts into
 * the sector never reached that branch, so the banner stayed empty.
 *
 * The fix routes the warning off the single universal cross-sector hop choke
 * point (`startSquadMemberTransit`) into a per-destination `IncomingRegistry`, so
 * EVERY warp decision into an occupied sector is announced + cleared on arrival.
 *
 * This test is the headline regression: a roaming squad warping into the player's
 * sector. It MUST FAIL on pre-fix code (no warning ever arrives) and PASS after.
 *
 * The level the bug lives at: cross-room broadcast (a departure in sector A must
 * reach an occupant of sector B) — only the multi-room living-world harness
 * exercises it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { SHIP_KINDS_LIST } from '../../../src/shared-types/shipKinds.js';

const KIND = SHIP_KINDS_LIST[0]!.id;

interface WarnMsg {
  id: string;
  label: string;
  count: number;
  countdownMs: number;
  disposition?: string;
}

describe('Incoming-warp HUD feed (Phase-4 P0)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('announces a NEUTRAL roaming squad to the destination sector, then clears it on arrival', async () => {
    // greenfall (entry edge) is the squad home; emerald-span (interior) is the only
    // live neighbour, so an idle squad slow-drifts inward via a real hop. A player
    // sits in emerald-span and collects the incoming-warp HUD messages exactly as the
    // browser would (room.onMessage), so the assertion crosses the real broadcast.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8,
      seed: 11,
      director: { roamIntervalMs: 100, hopTravelMs: 40 },
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      6000,
      'squad gathered at its home edge',
    );

    const warnings: WarnMsg[] = [];
    const cleared: string[] = [];
    const room = await h.connectActive(randomUUID(), 'emerald-span', { shipKind: KIND });
    room.onMessage('warp_warning', (m: unknown) => warnings.push(m as WarnMsg));
    room.onMessage('warp_warning_clear', (m: unknown) => cleared.push((m as { id: string }).id));

    // A member departing greenfall FOR emerald-span registers an inbound + broadcasts
    // to emerald-span's occupants — the case all 3 prior fixes missed.
    await h.waitUntil(() => warnings.length > 0, 8000, 'an incoming warp_warning reached emerald-span');

    const w = warnings[0]!;
    // A roaming pack is NEUTRAL (amber), not an enemy wave.
    expect(w.disposition).toBe('neutral');
    expect(typeof w.id).toBe('string');
    expect(w.count).toBeGreaterThanOrEqual(1);

    // Once the squad gathers in sol-prime, the inbound entry clears.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['emerald-span']!.bots > 0,
      8000,
      'a member arrived in emerald-span',
    );
    await h.waitUntil(() => cleared.includes(w.id), 6000, 'the inbound cleared on arrival');
  }, 30_000);
});
