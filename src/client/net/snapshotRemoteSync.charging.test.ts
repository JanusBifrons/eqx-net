import { describe, expect, it } from 'vitest';
import { applyDroneMountAngles } from './snapshotRemoteSync.js';
import type { RenderMirror, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

function mirrorWith(ids: number[]): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  for (const id of ids) swarm.set(id, { kind: 1, x: 0, y: 0, angle: 0, radius: 12 } as SwarmRenderState);
  return { swarm } as unknown as RenderMirror;
}

function snap(drones: SnapshotMessage['drones']): SnapshotMessage {
  return { drones } as unknown as SnapshotMessage;
}

describe('applyDroneMountAngles — P3c charge telegraph', () => {
  it('marks charging drones, and clears them when they drop out of the slice', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, charging: true }, { id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.charging).toBe(true);
    expect(m.swarm!.get(2)!.charging).toBeFalsy();
    // Next snapshot: drone 1 finished charging and has nothing else to report,
    // so the server omits it entirely — the client must still clear the bit.
    applyDroneMountAngles(snap([{ id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.charging).toBe(false);
    // And with no drones slice at all.
    applyDroneMountAngles(snap([{ id: 1, charging: true }]), m);
    applyDroneMountAngles(snap(undefined), m);
    expect(m.swarm!.get(1)!.charging).toBe(false);
  });
});
