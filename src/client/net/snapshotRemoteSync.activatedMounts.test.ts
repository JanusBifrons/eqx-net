/**
 * Phase 4 WS-B3 — the snapshot `states[].mounts` slice decodes into each ship's
 * `mirror.ships[id].activatedMounts` (the PUBLIC activated latent mounts the
 * renderer draws as extra turrets). Emit-when-non-empty on the wire, so absent
 * ⇒ no activated mounts ⇒ the mirror field is cleared back to undefined. Runs
 * AFTER `routeSnapshotShipStates`, so `snap.states` is keyed by playerId,
 * matching `mirror.ships`.
 */
import { describe, it, expect } from 'vitest';
import { applyActivatedMounts } from './snapshotRemoteSync.js';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';

type Activated = Array<{ slotId: string; weaponId: string }>;

function shipEntry(): ShipRenderState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0 } as unknown as ShipRenderState;
}

function mirrorWith(ids: string[]): RenderMirror {
  const ships = new Map<string, ShipRenderState>();
  for (const id of ids) ships.set(id, shipEntry());
  return { ships } as unknown as RenderMirror;
}

function snapWith(states: Record<string, { mounts?: Activated }>): SnapshotMessage {
  return { states } as unknown as SnapshotMessage;
}

describe('applyActivatedMounts — states[].mounts → mirror.ships[id].activatedMounts (WS-B3)', () => {
  it('mirrors a non-empty activated-mount list onto the matching ship entry', () => {
    const mirror = mirrorWith(['p1']);
    applyActivatedMounts(snapWith({ p1: { mounts: [{ slotId: 'latent-wing-l', weaponId: 'laser' }] } }), mirror);
    expect(mirror.ships.get('p1')!.activatedMounts).toEqual([{ slotId: 'latent-wing-l', weaponId: 'laser' }]);
  });

  it('clears a stale list when the wire omits it (absent ⇒ no activated mounts)', () => {
    const mirror = mirrorWith(['p1']);
    mirror.ships.get('p1')!.activatedMounts = [{ slotId: 'latent-wing-l', weaponId: 'laser' }]; // stale
    applyActivatedMounts(snapWith({ p1: {} }), mirror);
    expect(mirror.ships.get('p1')!.activatedMounts).toBeUndefined();
  });

  it('clears the field for an empty list', () => {
    const mirror = mirrorWith(['p1']);
    mirror.ships.get('p1')!.activatedMounts = [{ slotId: 'latent-wing-l', weaponId: 'laser' }];
    applyActivatedMounts(snapWith({ p1: { mounts: [] } }), mirror);
    expect(mirror.ships.get('p1')!.activatedMounts).toBeUndefined();
  });

  it('skips a state whose key is not in the mirror (out of interest)', () => {
    const mirror = mirrorWith(['p1']);
    expect(() => applyActivatedMounts(snapWith({ ghost: { mounts: [{ slotId: 'x', weaponId: 'laser' }] } }), mirror)).not.toThrow();
    expect(mirror.ships.get('p1')!.activatedMounts).toBeUndefined();
  });

  it('handles multiple ships independently', () => {
    const mirror = mirrorWith(['a', 'b']);
    applyActivatedMounts(snapWith({
      a: { mounts: [{ slotId: 'latent-wing-r', weaponId: 'heat-seeker' }] },
      b: {},
    }), mirror);
    expect(mirror.ships.get('a')!.activatedMounts).toEqual([{ slotId: 'latent-wing-r', weaponId: 'heat-seeker' }]);
    expect(mirror.ships.get('b')!.activatedMounts).toBeUndefined();
  });
});
