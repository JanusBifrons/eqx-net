/**
 * Sandbox exits (docs/features/sandbox.md): a sealed sector has no warp,
 * fleet warp or teleport hop in or out; galaxy hops are unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransitOrchestrator, type TransitHostRoom } from './TransitOrchestrator.js';
import { Bus } from '../../core/events/Bus.js';
import { SAB_TOTAL_BYTES } from '../../shared-types/sabLayout.js';
import { SANDBOX_SECTOR_KEY } from '../rooms/sealedSectors.js';

function room(sectorKey: string): { room: TransitHostRoom; reasons: Array<string | undefined> } {
  const reasons: Array<string | undefined> = [];
  const r = {
    sectorKey,
    bus: new Bus(),
    sabF32: new Float32Array(new SharedArrayBuffer(SAB_TOTAL_BYTES)),
    playerToSlot: new Map([['p1', 0]]),
    playerToUser: new Map([['p1', 'user']]),
    playerToActiveShipInstance: new Map<string, string>(),
    lastFireClientTick: new Map<string, number>(),
    getShipHealth: () => 100,
    hasLiveHull: () => true,
    getShipKind: () => 'fighter',
    playerToTransitInFlight: new Set<string>(),
    clientForPlayer: () => ({ send: (_c: string, m: { reason?: string }) => { reasons.push(m.reason); } }),
    broadcast: () => undefined,
    canFleetWarp: () => true,
    holdFleetShips: () => undefined,
    releaseFleetShips: () => undefined,
    fleetAnchor: () => null,
    handOffHulls: () => [],
  } as unknown as TransitHostRoom;
  return { room: r, reasons };
}

describe('sealed sector exits', () => {
  it('a warp out of the sandbox is refused (destination_unavailable)', () => {
    const { room: r, reasons } = room(SANDBOX_SECTOR_KEY);
    const orch = new TransitOrchestrator(r);
    expect(orch.beginTransit('p1', 'sol-prime')).toBe(false);
    expect(reasons).toEqual(['destination_unavailable']);
    expect(orch.isInFlight('p1')).toBe(false);
  });

  it('a warp INTO the sandbox from the galaxy is refused', () => {
    const { room: r, reasons } = room('sol-prime');
    expect(new TransitOrchestrator(r).beginTransit('p1', SANDBOX_SECTOR_KEY)).toBe(false);
    expect(reasons).toEqual(['destination_unavailable']);
  });

  it('a fleet warp out of the sandbox is refused', () => {
    const { room: r, reasons } = room(SANDBOX_SECTOR_KEY);
    expect(new TransitOrchestrator(r).beginFleetTransit('p1', 'sol-prime', ['s1'])).toBeNull();
    expect(reasons).toEqual(['destination_unavailable']);
  });

  it('a teleport hop out of or into the sandbox is refused', () => {
    expect(new TransitOrchestrator(room(SANDBOX_SECTOR_KEY).room).teleportOut('p1', 'sol-prime', { x: 0, y: 0 })).toBe(false);
    expect(new TransitOrchestrator(room('sol-prime').room).teleportOut('p1', SANDBOX_SECTOR_KEY, { x: 0, y: 0 })).toBe(false);
  });

  it('a galaxy warp between neighbours still spools', () => {
    vi.useFakeTimers();
    const { room: r } = room('sol-prime');
    const orch = new TransitOrchestrator(r);
    expect(orch.beginTransit('p1', 'vega-reach')).toBe(true);
    orch.cancelTransit('p1', 'manual');
    vi.useRealTimers();
  });
});
