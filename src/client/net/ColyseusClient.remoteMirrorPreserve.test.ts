/**
 * A remote ship's NON-spatial mirror fields survive a room-state patch.
 *
 * Found filming the warp-onlooker shot (2026-11-07): `syncMirror` replaced a
 * remote ship's mirror entry with a fresh object on every Colyseus state
 * patch, wiping fields only the snapshot writes (`warp`, `level`,
 * `shieldDown`, `mountAngles`). The next snapshot put them back, so they
 * FLICKERED at the patch rate: an onlooker's warp phase blinked
 * 1 → undefined → 1, restarting the spool glow every patch, so the engine
 * build-up never showed. The rule (src/client/CLAUDE.md "Per-frame
 * mirror.ships.set() rebuild MUST preserve") applies to this site too.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { ShipRenderState } from '@core/contracts/IRenderer';

interface Internals {
  syncMirror(state: unknown): void;
  mirror: { ships: Map<string, ShipRenderState>; localPlayerId: string | null };
}

function stateWithRemote(x: number): { ships: Map<string, Record<string, unknown>> } {
  const ships = new Map<string, Record<string, unknown>>();
  ships.set('remote', { playerId: 'remote', shipInstanceId: 'S1', isActive: true, alive: true, kind: 'fighter', displayName: 'Bob', x, y: 0, angle: 0, vx: 0, vy: 0 });
  return { ships };
}

describe('syncMirror keeps a remote ship\'s snapshot-only fields', () => {
  it('warp / level / shieldDown / mountAngles survive a state patch; pose updates', () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.syncMirror(stateWithRemote(10));
    const e = c.mirror.ships.get('remote')!;
    e.warp = 1;
    e.level = 3;
    e.shieldDown = true;
    e.mountAngles = [0.25];

    c.syncMirror(stateWithRemote(20)); // any patch

    const after = c.mirror.ships.get('remote')!;
    expect(after.warp).toBe(1);
    expect(after.level).toBe(3);
    expect(after.shieldDown).toBe(true);
    expect(after.mountAngles).toEqual([0.25]);
    expect(after.kind).toBe('fighter');
    expect(after.displayName).toBe('Bob');
    expect(after.x).toBe(20);
  });
});
