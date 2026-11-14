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

describe('applyDroneMountAngles — charge telegraph', () => {
  it('marks charging mounts with their start tick, and clears them when they drop out of the slice', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, chargingMask: 0b101, chargeStartTick: 900 }, { id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.chargingMask).toBe(0b101);
    expect(m.swarm!.get(1)!.chargeStartTick).toBe(900);
    expect(m.swarm!.get(2)!.chargingMask ?? 0).toBe(0);
    // Next snapshot: drone 1 finished charging and has nothing else to report,
    // so the server omits it entirely — the client must still clear the bits.
    applyDroneMountAngles(snap([{ id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.chargingMask).toBe(0);
    expect(m.swarm!.get(1)!.chargeStartTick).toBeUndefined();
    // And with no drones slice at all.
    applyDroneMountAngles(snap([{ id: 1, chargingMask: 1, chargeStartTick: 5 }]), m);
    applyDroneMountAngles(snap(undefined), m);
    expect(m.swarm!.get(1)!.chargingMask).toBe(0);
  });

  it('carries per-mount charge offsets, replaces them each snapshot, and clears them with the charge', () => {
    const m = mirrorWith([1]);
    applyDroneMountAngles(snap([{ id: 1, chargingMask: 0b11, chargeStartTick: 900, chargeOffsets: [0, 120] }]), m);
    expect(m.swarm!.get(1)!.chargeOffsets).toEqual([0, 120]);
    // Both now charge from the same tick: the server omits the offsets.
    applyDroneMountAngles(snap([{ id: 1, chargingMask: 0b11, chargeStartTick: 900 }]), m);
    expect(m.swarm!.get(1)!.chargeOffsets).toBeUndefined();
    applyDroneMountAngles(snap([{ id: 1, chargingMask: 0b11, chargeStartTick: 900, chargeOffsets: [0, 120] }]), m);
    applyDroneMountAngles(snap(undefined), m);
    expect(m.swarm!.get(1)!.chargeOffsets).toBeUndefined();
  });

  it('take 12 — an AI ship holding boost is marked boosting, and clears when it lets go', () => {
    const m = mirrorWith([1, 2]);
    applyDroneMountAngles(snap([{ id: 1, boost: true }, { id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.boosting).toBe(true);
    expect(m.swarm!.get(2)!.boosting).toBeFalsy();
    // Let go: the server omits it (nothing else to report), so the bit clears.
    applyDroneMountAngles(snap([{ id: 2, hostile: true }]), m);
    expect(m.swarm!.get(1)!.boosting).toBe(false);
    applyDroneMountAngles(snap([{ id: 1, boost: true }]), m);
    applyDroneMountAngles(snap(undefined), m);
    expect(m.swarm!.get(1)!.boosting).toBe(false);
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
