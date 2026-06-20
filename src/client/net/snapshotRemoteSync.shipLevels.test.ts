/**
 * Phase 4 WS-B1 — the snapshot `states[].level` slice decodes into each ship's
 * `mirror.ships[id].level` (the PUBLIC in-world level badge). Emit-when > 1 on
 * the wire, so absent ⇒ level 1 ⇒ the mirror field is cleared back to undefined
 * (no badge). Runs AFTER `routeSnapshotShipStates`, so `snap.states` is keyed by
 * playerId, matching `mirror.ships`.
 */
import { describe, it, expect } from 'vitest';
import { applyShipLevels } from './snapshotRemoteSync.js';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';

function shipEntry(level?: number): ShipRenderState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, level } as unknown as ShipRenderState;
}

function mirrorWith(ids: string[]): RenderMirror {
  const ships = new Map<string, ShipRenderState>();
  for (const id of ids) ships.set(id, shipEntry());
  return { ships } as unknown as RenderMirror;
}

function snapWith(states: Record<string, { level?: number }>): SnapshotMessage {
  return { states } as unknown as SnapshotMessage;
}

describe('applyShipLevels — states[].level → mirror.ships[id].level (WS-B1)', () => {
  it('mirrors a level > 1 onto the matching ship entry', () => {
    const mirror = mirrorWith(['p1']);
    applyShipLevels(snapWith({ p1: { level: 4 } }), mirror);
    expect(mirror.ships.get('p1')!.level).toBe(4);
  });

  it('clears a stale level when the wire omits it (absent ⇒ level 1, no badge)', () => {
    const mirror = mirrorWith(['p1']);
    mirror.ships.get('p1')!.level = 5; // stale
    applyShipLevels(snapWith({ p1: {} }), mirror);
    expect(mirror.ships.get('p1')!.level).toBeUndefined();
  });

  it('treats level 1 as un-levelled (clears the field)', () => {
    const mirror = mirrorWith(['p1']);
    mirror.ships.get('p1')!.level = 3;
    applyShipLevels(snapWith({ p1: { level: 1 } }), mirror);
    expect(mirror.ships.get('p1')!.level).toBeUndefined();
  });

  it('skips a state whose key is not in the mirror (out of interest)', () => {
    const mirror = mirrorWith(['p1']);
    expect(() => applyShipLevels(snapWith({ ghost: { level: 7 } }), mirror)).not.toThrow();
    expect(mirror.ships.get('p1')!.level).toBeUndefined();
  });

  it('handles multiple ships independently', () => {
    const mirror = mirrorWith(['a', 'b', 'c']);
    applyShipLevels(snapWith({ a: { level: 2 }, b: {}, c: { level: 9 } }), mirror);
    expect(mirror.ships.get('a')!.level).toBe(2);
    expect(mirror.ships.get('b')!.level).toBeUndefined();
    expect(mirror.ships.get('c')!.level).toBe(9);
  });
});
