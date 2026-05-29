/**
 * Phase 2 client-side WebRTC DataChannel transport — failing-first unit test.
 *
 * The Phase 2 RTCPeerConnection plumbing is NOT unit-testable in a plain
 * vitest worker (no DOM RTC). The reordering guard + decode pipeline IS,
 * and that's what this file covers via the pure `DataChannelSnapshotReceiver`
 * helper.
 *
 * Coverage matches the plan's stated cases:
 *   - In-order snapshots [10, 11, 12] all pass through.
 *   - Out-of-order [10, 12, 11] drops the late 11.
 *   - Duplicate (10, 10) drops the second.
 *   - Garbage payload that doesn't decode is dropped silently (no crash).
 *   - `snap_dropped_old` event is emitted on each drop with the drop reason.
 *
 * Plan: swift-otter (Phase 2).
 */

import { describe, expect, it, vi } from 'vitest';
import { Packr } from '@colyseus/msgpackr';
import { DataChannelSnapshotReceiver } from './dataChannelTransport.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

const packr = new Packr({ encodeUndefinedAsNil: true });

function packSnap(serverTick: number): Uint8Array {
  const snap: SnapshotMessage = {
    type: 'snapshot',
    serverTick,
    states: {},
    ackedTick: 0,
  } as SnapshotMessage;
  return packr.pack(snap);
}

describe('DataChannelSnapshotReceiver', () => {
  it('forwards in-order snapshots [10, 11, 12]', () => {
    const onSnapshot = vi.fn();
    const onDiag = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot, onDiag });

    receiver.handleBinary(packSnap(10));
    receiver.handleBinary(packSnap(11));
    receiver.handleBinary(packSnap(12));

    expect(onSnapshot).toHaveBeenCalledTimes(3);
    expect((onSnapshot.mock.calls[0]?.[0] as SnapshotMessage).serverTick).toBe(10);
    expect((onSnapshot.mock.calls[1]?.[0] as SnapshotMessage).serverTick).toBe(11);
    expect((onSnapshot.mock.calls[2]?.[0] as SnapshotMessage).serverTick).toBe(12);
    expect(onDiag).not.toHaveBeenCalled();
  });

  it('drops out-of-order snapshot in [10, 12, 11]', () => {
    const onSnapshot = vi.fn();
    const onDiag = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot, onDiag });

    receiver.handleBinary(packSnap(10));
    receiver.handleBinary(packSnap(12));
    receiver.handleBinary(packSnap(11));

    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect((onSnapshot.mock.calls[0]?.[0] as SnapshotMessage).serverTick).toBe(10);
    expect((onSnapshot.mock.calls[1]?.[0] as SnapshotMessage).serverTick).toBe(12);
    const dropCalls = onDiag.mock.calls.filter((c) => (c[0] as string) === 'snap_dropped_old');
    expect(dropCalls.length).toBe(1);
    expect((dropCalls[0]![1] as { serverTick: number }).serverTick).toBe(11);
  });

  it('drops duplicate serverTick (10, 10)', () => {
    const onSnapshot = vi.fn();
    const onDiag = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot, onDiag });

    receiver.handleBinary(packSnap(10));
    receiver.handleBinary(packSnap(10));

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    const dropCalls = onDiag.mock.calls.filter((c) => (c[0] as string) === 'snap_dropped_old');
    expect(dropCalls.length).toBe(1);
  });

  it('drops a payload that cannot be decoded and never crashes', () => {
    const onSnapshot = vi.fn();
    const onDiag = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot, onDiag });

    expect(() => receiver.handleBinary(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).not.toThrow();
    expect(onSnapshot).not.toHaveBeenCalled();
    const errCalls = onDiag.mock.calls.filter((c) => (c[0] as string) === 'snap_dropped_decode');
    expect(errCalls.length).toBe(1);
  });

  it('drops a payload that is missing the snapshot type field', () => {
    const onSnapshot = vi.fn();
    const onDiag = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot, onDiag });

    const otherShape = packr.pack({ type: 'not-a-snapshot', foo: 'bar' });
    receiver.handleBinary(otherShape);

    expect(onSnapshot).not.toHaveBeenCalled();
    const errCalls = onDiag.mock.calls.filter((c) => (c[0] as string) === 'snap_dropped_shape');
    expect(errCalls.length).toBe(1);
  });

  it('reset() clears the last-seen tick (used on sector handoff)', () => {
    const onSnapshot = vi.fn();
    const receiver = new DataChannelSnapshotReceiver({ onSnapshot });

    receiver.handleBinary(packSnap(500));
    receiver.reset();
    receiver.handleBinary(packSnap(10));

    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect((onSnapshot.mock.calls[1]?.[0] as SnapshotMessage).serverTick).toBe(10);
  });
});
