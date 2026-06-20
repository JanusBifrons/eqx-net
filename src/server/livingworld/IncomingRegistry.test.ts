/**
 * Unit coverage for the IncomingRegistry (Phase-4 P0) — the per-destination
 * "incoming ships" feed. Fast insurance for the register / clear / dedup /
 * dest-change rules; the cross-room broadcast wiring is locked at the
 * integration level (tests/integration/sectorRoom/incomingWarp.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { IncomingRegistry, type IncomingEntry } from './IncomingRegistry.js';
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
    // Unused by the registry — present only to satisfy the structural type.
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

describe('IncomingRegistry', () => {
  it('register broadcasts a warp_warning to the destination room', () => {
    const dest = fakeRoom();
    const reg = new IncomingRegistry(new Map([['sol-prime', dest]]));
    reg.register(entry({ disposition: 'enemy' }));
    expect(dest.warnings).toHaveLength(1);
    expect(dest.warnings[0]).toMatchObject({ id: 'squad-0', count: 8, disposition: 'enemy', countdownMs: 5000 });
    expect(reg.has('squad-0', 'sol-prime')).toBe(true);
  });

  it('re-registering an UNCHANGED inbound does not re-broadcast (8-members-one-tick dedup)', () => {
    const dest = fakeRoom();
    const reg = new IncomingRegistry(new Map([['sol-prime', dest]]));
    reg.register(entry());
    reg.register(entry());
    reg.register(entry());
    expect(dest.warnings).toHaveLength(1); // one banner for the whole squad
  });

  it('a re-tasked squad (new destination) clears the old dest and announces the new', () => {
    const a = fakeRoom();
    const b = fakeRoom();
    const reg = new IncomingRegistry(new Map([['sol-prime', a], ['mars', b]]));
    reg.register(entry({ destSectorKey: 'sol-prime' }));
    reg.register(entry({ destSectorKey: 'mars' }));
    expect(a.clears).toHaveLength(1); // old destination cleared
    expect(a.clears[0]!.id).toBe('squad-0');
    expect(b.warnings).toHaveLength(1); // new destination announced
    expect(reg.has('squad-0', 'sol-prime')).toBe(false);
    expect(reg.has('squad-0', 'mars')).toBe(true);
  });

  it('clear broadcasts a warp_warning_clear and drops the entry; unknown clear is a no-op', () => {
    const dest = fakeRoom();
    const reg = new IncomingRegistry(new Map([['sol-prime', dest]]));
    reg.register(entry());
    reg.clear('squad-0', 'sol-prime');
    expect(dest.clears).toHaveLength(1);
    expect(dest.clears[0]!.id).toBe('squad-0');
    expect(reg.has('squad-0', 'sol-prime')).toBe(false);
    reg.clear('squad-0', 'sol-prime'); // idempotent
    expect(dest.clears).toHaveLength(1);
  });

  it('register to an unknown destination room registers but does not throw / broadcast', () => {
    const reg = new IncomingRegistry(new Map());
    expect(() => reg.register(entry({ destSectorKey: 'nowhere' }))).not.toThrow();
    expect(reg.has('squad-0', 'nowhere')).toBe(true);
  });

  it('reset clears every entry without broadcasting', () => {
    const dest = fakeRoom();
    const reg = new IncomingRegistry(new Map([['sol-prime', dest]]));
    reg.register(entry());
    reg.reset();
    expect(reg.has('squad-0', 'sol-prime')).toBe(false);
    expect(dest.clears).toHaveLength(0);
  });
});
