/**
 * Reproduce-first regression lock for the Phase-2 "hostile drones aren't hostile"
 * bug (Equinox Tweaks Phase 2, issue 3 — plan idempotent-lagoon Phase 2).
 *
 * USER REPORT (on-device): "I had a READY base, the galaxy map showed the drones
 * as hostile, I spawned into their sector and they weren't fucking hostile —
 * they were just sitting there, didn't attack, weren't warping."
 *
 * ROOT CAUSE (confirmed from the live server's /dev/audit + /dev/population this
 * session): waves are dispatched at the base, but a drone squad crosses the
 * galaxy HOP-BY-HOP and each hop takes the full `SPOOL_DURATION_MS` (30 s) — the
 * value was a PLAYER-warp mechanic wrongly inherited by drone hops. A wave
 * therefore takes ~30 s PER HOP to reach the base, killed members respawn at the
 * galaxy edge and restart the journey, and the squad never gets a member to
 * SETTLE in the target sector. `SquadBehaviour` only returns `attack` when
 * `membersInSector > 0` at the target, so the squad stays `warping` FOREVER,
 * `markSquadHostileToFaction` never fires, and a player who spawns into the
 * "red on the map" sector is never marked hostile (a drone in COMBAT treats
 * non-hostile players as invisible). Live proof: 17 wave_dispatched, 0
 * wave_repelled, 0 bots ever in the target sector, 33/56 bots stuck inTransit.
 *
 * THIS TEST drives the user's exact scenario: a READY base, owner PRESENT in the
 * base sector, and asserts the wave makes the drones HOSTILE TO THE OWNER (a
 * `bot_aggro` targeting them) within a playable window. It reads the PRODUCTION
 * default drone-hop spool (`DEFAULT_LIVING_WORLD_OPTIONS.spoolMs`) so it FAILS on
 * the current 30 s default (the wave never arrives) and PASSES once the default
 * is cut to a playable per-hop dwell — and re-fails if anyone reverts it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { DEFAULT_LIVING_WORLD_OPTIONS } from '../../../src/server/livingworld/LivingWorldDirector.js';
import type { BotAggroEvent } from '../../../src/shared-types/messages.js';

describe('SectorRoom integration — a wave engages the PRESENT base owner (Phase-2 issue 3)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('drones turn hostile to the owner who spawned into their READY-base sector', async () => {
    const OWNER = randomUUID();
    h = await bootLivingWorldTestServer({
      // greenfall is the only ENTRY (edge) sector here; emerald-span is its
      // interior neighbour where the base lives — ONE hop, the cheapest case
      // (the live bug targets sol-prime, MANY hops, so it's even worse there).
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8, // one full squad
      seed: 5,
      bases: [
        {
          sector: 'emerald-span',
          owner: OWNER, // the wave targets the OWNER's faction
          structures: [
            { kind: 'capital', x: 0, y: 0 },
            { kind: 'solar', x: 250, y: 0 },
            { kind: 'miner', x: -350, y: 0 },
            { kind: 'turret', x: 0, y: 350 },
          ],
        },
      ],
      // Immediate dispatch, fast control tick — BUT use the PRODUCTION default
      // drone-hop spool (NOT the harness's 40 ms). This is the value under test:
      // at 30 s/hop the wave never arrives within the window; at a playable dwell
      // it does. hopTravelMs default (0) keeps the hop atomic + visible.
      director: {
        dispatchIntervalMs: 1,
        controlIntervalMs: 50,
        spoolMs: DEFAULT_LIVING_WORLD_OPTIONS.spoolMs,
      },
    });

    // The owner is PRESENT in their base sector (active hull — connectActive
    // sends client_ready so the room counts them).
    const ownerRoom = await h.connectActive(OWNER, 'emerald-span');

    // Capture every bot_aggro the owner's client receives.
    const aggrosAtOwner: BotAggroEvent[] = [];
    ownerRoom.onMessage('bot_aggro', (e: BotAggroEvent) => {
      if (e.targetPlayerId === OWNER) aggrosAtOwner.push(e);
    });

    // THE assertion: within a playable window the wave reaches the base and the
    // drones turn hostile to the present owner. Current 30 s spool ⇒ the wave is
    // still mid-spool one hop away ⇒ never `attacking` ⇒ no aggro ⇒ TIMES OUT.
    await h.waitUntil(
      () => aggrosAtOwner.length > 0,
      14_000,
      'a drone wave turns hostile to the present base owner',
    );
    expect(aggrosAtOwner.length).toBeGreaterThan(0);

    // And the squad genuinely reached the attacking state (not a stray aggro).
    expect(h.director.squadSnapshot().byState.attacking).toBeGreaterThan(0);
  }, 30_000);
});
