/**
 * Campaign PR 2.1 — client half of the snapshot hostility bit (invariant
 * #16). The per-recipient `drones[].hostile` flag must feed the hostility
 * ledger via the `onHostile` callback so a mid-wave joiner converges from
 * the snapshot stream alone; absence must NOT clear (the ledger's
 * time-decay owns forgetting, same as the `bot_aggro` event path). The
 * server-side + wire lock is tests/integration/sectorRoom/hostilityOnSnapshot.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyDroneMountAngles } from './snapshotRemoteSync.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages.js';

function makeMirror(): RenderMirror {
  return { swarm: new Map([[7, { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }]]) } as unknown as RenderMirror;
}

function snapWithDrones(drones: SnapshotMessage['drones']): SnapshotMessage {
  return { serverTick: 100, states: {}, drones } as unknown as SnapshotMessage;
}

describe('applyDroneMountAngles — snapshot hostility bit (campaign 2.1)', () => {
  it('invokes onHostile for every hostile:true entry', () => {
    const onHostile = vi.fn();
    applyDroneMountAngles(snapWithDrones([{ id: 7, hostile: true }]), makeMirror(), onHostile);
    expect(onHostile).toHaveBeenCalledTimes(1);
    expect(onHostile).toHaveBeenCalledWith(7);
  });

  it('does NOT invoke onHostile for neutral entries (absent flag never clears)', () => {
    const onHostile = vi.fn();
    applyDroneMountAngles(snapWithDrones([{ id: 7, shieldDown: true }]), makeMirror(), onHostile);
    expect(onHostile).not.toHaveBeenCalled();
  });

  it('marks hostility even for a drone not yet in the swarm mirror (binary packet race)', () => {
    // The AiController pending-hostility buffer handles aggro-before-register;
    // the snapshot path must feed it the same way instead of skipping on a
    // mirror miss.
    const onHostile = vi.fn();
    const mirror = { swarm: new Map() } as unknown as RenderMirror;
    applyDroneMountAngles(snapWithDrones([{ id: 9, hostile: true }]), mirror, onHostile);
    expect(onHostile).toHaveBeenCalledWith(9);
  });
});
