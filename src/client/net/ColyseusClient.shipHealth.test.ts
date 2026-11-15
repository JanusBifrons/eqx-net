/**
 * RTS Part A step 8: every ship's room-state `health` / `maxHealth` (synced
 * for pilot- AND AI-flown ships, dropped by `syncMirror` before) is copied onto
 * its mirror entry, so the fleet panel reads hull % from there instead of the
 * private `fleet_status` stream.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { ShipRenderState } from '@core/contracts/IRenderer';
import { copySchemaHealth, shipHullPct } from './shipSchemaHealth.js';

interface Internals {
  syncMirror(state: unknown): void;
  mirror: { ships: Map<string, ShipRenderState>; localPlayerId: string | null };
}

function state(hullHealth: number, pilotHealth: number): { ships: Map<string, Record<string, unknown>> } {
  const ships = new Map<string, Record<string, unknown>>();
  ships.set('S1', { playerId: 'remote', shipInstanceId: 'S1', isActive: true, alive: true, kind: 'fighter', health: pilotHealth, maxHealth: 400, x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
  // My parked (AI-flown) hull, keyed by its shipInstanceId in the one ship list.
  ships.set('H1', { playerId: 'me', shipInstanceId: 'H1', isActive: false, alive: true, kind: 'scout', health: hullHealth, maxHealth: 200, x: 0, y: 0, angle: 0, vx: 0, vy: 0 });
  return { ships };
}

describe('syncMirror copies room-state ship health', () => {
  it('onto pilot-flown and AI-flown entries, and follows each patch', () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.syncMirror(state(150, 400));
    expect(c.mirror.ships.get('H1')).toMatchObject({ health: 150, maxHealth: 200 });
    expect(c.mirror.ships.get('remote')).toMatchObject({ health: 400, maxHealth: 400 });
    expect(shipHullPct(c.mirror.ships.get('H1'))).toBe(75);

    c.syncMirror(state(50, 100));
    expect(shipHullPct(c.mirror.ships.get('H1'))).toBe(25);
    expect(shipHullPct(c.mirror.ships.get('remote'))).toBe(25);
  });
});

describe('shipSchemaHealth helpers', () => {
  it('copies only finite numbers', () => {
    const e: ShipRenderState = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };
    copySchemaHealth({ health: 'x', maxHealth: Number.NaN }, e);
    expect(e.health).toBeUndefined();
    expect(e.maxHealth).toBeUndefined();
    copySchemaHealth({ health: 30, maxHealth: 60 }, e);
    expect(shipHullPct(e)).toBe(50);
  });

  it('hull % is null until known, clamped to 0..100', () => {
    expect(shipHullPct(undefined)).toBeNull();
    expect(shipHullPct({ x: 0, y: 0, angle: 0, vx: 0, vy: 0 })).toBeNull();
    expect(shipHullPct({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, health: 5, maxHealth: 0 })).toBeNull();
    expect(shipHullPct({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, health: 120, maxHealth: 100 })).toBe(100);
    expect(shipHullPct({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, health: -5, maxHealth: 100 })).toBe(0);
  });
});
