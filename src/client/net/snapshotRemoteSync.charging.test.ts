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

  it('W2a — carries an NPC warp phase, and clears it when the bot stops warping', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, warp: 1 }, { id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.warp).toBe(1);
    expect(m.swarm!.get(2)!.warp).toBeUndefined();
    applyDroneMountAngles(snap([{ id: 1, warp: 2 }]), m);
    expect(m.swarm!.get(1)!.warp).toBe(2);
    // Idle again: the server omits it, so the phase must clear.
    applyDroneMountAngles(snap(undefined), m);
    expect(m.swarm!.get(1)!.warp).toBeUndefined();
  });

  it('P4a — carries an elite name, and clears it when the elite drops out', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, elite: 'Dread Vexis' }]), m);
    expect(m.swarm!.get(1)!.eliteName).toBe('Dread Vexis');
    expect(m.swarm!.get(2)!.eliteName).toBeUndefined();
    applyDroneMountAngles(snap([{ id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.eliteName).toBeUndefined();
  });

  it('v4 M2 — a patrol ship keeps the faction it flies for', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, fac: 'core' }]), m);
    expect(m.swarm!.get(1)!.faction).toBe('core');
    expect(m.swarm!.get(2)!.faction).toBeUndefined();
    // A patrol always reports while in interest; its faction never changes.
    applyDroneMountAngles(snap([{ id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.faction).toBe('core');
  });
});
