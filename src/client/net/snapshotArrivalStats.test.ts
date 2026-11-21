import { beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_SEND_GAP_MS,
  SNAPSHOT_NOMINAL_INTERVAL_MS,
  getArrivalLateBadCount,
  getArrivalLateWarnCount,
  getNetGapCount,
  getNetGapSevereCount,
  getSnapshotArrivalCount,
  noteSnapshotArrival,
  resetSnapshotArrivalStats,
  takeArrivalLatenessPeakMs,
  takeServerSendGapPeakMs,
} from './snapshotArrivalStats.js';

/** Server and client clocks have different bases; the skew must cancel. */
const SKEW_MS = 123_456;
const ONE_WAY_MS = 40;

/** Feed `n` on-time snapshots from send time `send0`; returns the next send time. */
function onTime(send0: number, n: number): number {
  let send = send0;
  for (let i = 0; i < n; i++, send += SNAPSHOT_NOMINAL_INTERVAL_MS) {
    noteSnapshotArrival(send + SKEW_MS + ONE_WAY_MS, send);
  }
  return send;
}

describe('snapshotArrivalStats', () => {
  beforeEach(() => resetSnapshotArrivalStats());

  it('counts nothing late on an on-time link', () => {
    onTime(1000, 40);
    expect(getSnapshotArrivalCount()).toBe(40);
    expect(getArrivalLateWarnCount()).toBe(0);
    expect(getNetGapCount()).toBe(0);
    expect(takeServerSendGapPeakMs()).toBe(SNAPSHOT_NOMINAL_INTERVAL_MS);
    expect(takeArrivalLatenessPeakMs()).toBe(0);
  });

  it('blames the network when on-time sends arrive held then in a burst', () => {
    let send = onTime(1000, 20);
    // 8 sends on time, all held by the network and released together 500 ms late.
    const releaseAt = send + 7 * SNAPSHOT_NOMINAL_INTERVAL_MS + SKEW_MS + ONE_WAY_MS + 500;
    for (let i = 0; i < 8; i++, send += SNAPSHOT_NOMINAL_INTERVAL_MS) noteSnapshotArrival(releaseAt, send);
    expect(getNetGapCount()).toBe(1);
    expect(getNetGapSevereCount()).toBe(0);
    expect(getArrivalLateWarnCount()).toBeGreaterThanOrEqual(7);
    expect(getArrivalLateBadCount()).toBeGreaterThanOrEqual(3);
    expect(takeServerSendGapPeakMs()).toBe(SNAPSHOT_NOMINAL_INTERVAL_MS);
    expect(takeArrivalLatenessPeakMs()).toBeGreaterThan(500);
  });

  it('blames the server when the send itself was late', () => {
    let send = onTime(1000, 20);
    send += 600; // server stalled: the next stamp is 650 ms after the last
    onTime(send, 5);
    expect(takeServerSendGapPeakMs()).toBeGreaterThan(SERVER_SEND_GAP_MS);
    expect(getNetGapCount()).toBe(0);
    expect(getArrivalLateWarnCount()).toBe(0);
  });

  it('counts a network gap over 1 s as severe', () => {
    const send = onTime(1000, 10);
    noteSnapshotArrival(send + SKEW_MS + ONE_WAY_MS + 1500, send);
    expect(getNetGapCount()).toBe(1);
    expect(getNetGapSevereCount()).toBe(1);
  });

  it('takes the peaks once and resets on a new room', () => {
    onTime(1000, 10);
    expect(takeServerSendGapPeakMs()).toBe(SNAPSHOT_NOMINAL_INTERVAL_MS);
    expect(takeServerSendGapPeakMs()).toBe(0);
    resetSnapshotArrivalStats();
    expect(getSnapshotArrivalCount()).toBe(0);
    // A new server's stamp base must not read as a gap or as lateness.
    onTime(9_000_000, 10);
    expect(getNetGapCount()).toBe(0);
    expect(getArrivalLateWarnCount()).toBe(0);
  });

  it('counts arrivals without a send stamp but attributes nothing', () => {
    for (let t = 0; t < 1000; t += SNAPSHOT_NOMINAL_INTERVAL_MS) noteSnapshotArrival(t, undefined);
    expect(getSnapshotArrivalCount()).toBe(20);
    expect(getArrivalLateWarnCount()).toBe(0);
    expect(takeServerSendGapPeakMs()).toBe(0);
  });
});
