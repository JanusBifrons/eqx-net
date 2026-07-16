/**
 * Campaign PR 2.3 (anti-patterns review 2026-07, A5 / Part D #9) — failing-
 * first locks for the two residual incoming-warp holes ("ITS NOT WORKING",
 * 3 failed fix attempts before the registry; these are the 4th-generation
 * leaks the review found in the otherwise-correct architecture):
 *
 * 1. DEDUP SWALLOW: `register()` skipped the broadcast whenever an entry
 *    with identical count/label/disposition existed — FOREVER. One missed
 *    clear (`reconcileIncoming` sweeps at tick tail and can miss a squad
 *    object that is already gone) suppressed every subsequent identical
 *    warning to that sector. Fix: the dedup is TIME-BOUNDED — a re-register
 *    re-broadcasts once `INCOMING_REBROADCAST_MS` has elapsed, which also
 *    refreshes the banner for players who joined the sector mid-approach
 *    (invariant #16's late-joiner rule, at the event layer).
 *
 * 2. SILENT NO-ROOM DROP: a destination sector whose room isn't in the
 *    director's map (created later / engineering / disabled living world)
 *    dropped the warning with no trace. Fix: an injected `onUnknownDest`
 *    sink fires so the drop is loud.
 *
 * Mirrors the fakeRoom harness of IncomingRegistry.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { IncomingRegistry, INCOMING_REBROADCAST_MS, type IncomingEntry } from './IncomingRegistry.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { WarpWarningEvent, WarpWarningClearEvent } from '../../shared-types/messages.js';

interface FakeRoom extends LivingWorldRoom {
  warnings: WarpWarningEvent[];
  clears: WarpWarningClearEvent[];
}

function fakeRoom(): FakeRoom {
  const warnings: WarpWarningEvent[] = [];
  const clears: WarpWarningClearEvent[] = [];
  return {
    warnings,
    clears,
    broadcastWarpWarning: (m) => warnings.push(m),
    broadcastWarpWarningClear: (m) => clears.push(m),
    eventBus: () => ({}) as never,
    playerCount: () => 0,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: () => true,
    despawnLivingWorldBot: () => null,
    markBotHostile: () => {},
    factionHostility: (id) => ({ playerId: id, structureIds: [] }),
    factionBaseReadiness: () => [],
    setFactionUnderWave: () => {},
    markSquadHostileToFaction: () => {},
    purgeFactionHostility: () => {},
  };
}

function entry(over: Partial<IncomingEntry> = {}): IncomingEntry {
  return {
    id: 'squad-0',
    destSectorKey: 'sol-prime',
    sourceSectorKey: 'orion-belt',
    label: 'Legionnaire',
    count: 8,
    disposition: 'neutral',
    etaMs: 5000,
    ...over,
  };
}

describe('IncomingRegistry — time-bounded dedup + loud unknown-dest (campaign 2.3)', () => {
  it('an identical re-register within the window stays deduped (spam guard preserved)', () => {
    const room = fakeRoom();
    let now = 1_000;
    const reg = new IncomingRegistry(new Map([['sol-prime', room]]), { nowMs: () => now });
    reg.register(entry());
    now += 1_500; // one control tick later, same squad still hopping
    reg.register(entry());
    expect(room.warnings).toHaveLength(1);
  });

  it('an identical re-register AFTER the window re-broadcasts (heals a missed clear; refreshes late joiners)', () => {
    const room = fakeRoom();
    let now = 1_000;
    const reg = new IncomingRegistry(new Map([['sol-prime', room]]), { nowMs: () => now });
    reg.register(entry());
    now += INCOMING_REBROADCAST_MS + 1;
    reg.register(entry());
    expect(room.warnings).toHaveLength(2);
  });

  it('a clear resets the window — the next register broadcasts immediately', () => {
    const room = fakeRoom();
    let now = 1_000;
    const reg = new IncomingRegistry(new Map([['sol-prime', room]]), { nowMs: () => now });
    reg.register(entry());
    reg.clear('squad-0', 'sol-prime');
    now += 100;
    reg.register(entry());
    expect(room.warnings).toHaveLength(2);
  });

  it('a register to a destination with NO live room fires the onUnknownDest sink', () => {
    const onUnknownDest = vi.fn();
    const reg = new IncomingRegistry(new Map(), { nowMs: () => 0, onUnknownDest });
    reg.register(entry({ destSectorKey: 'ghost-sector' }));
    expect(onUnknownDest).toHaveBeenCalledWith('ghost-sector', 'squad-0');
  });
});
