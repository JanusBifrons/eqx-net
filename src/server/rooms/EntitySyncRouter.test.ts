/**
 * Generic Entity Pipeline B4 lock — the server EntitySyncRouter.
 *
 * The router is the single orchestration entry point for per-tick entity sync.
 * Its contract (the Phase B risk surface):
 *   - pose-core binary send runs BEFORE the json-slice send (HC#4 — the
 *     interestScratch / single query9 ordering is load-bearing);
 *   - sector-idle is evaluated BETWEEN the two sends (verbatim order — swarm's
 *     backpressure may fire before idle reads clients.length);
 *   - the sector-idle result is threaded into the json-slice send;
 *   - the tick-budget phase markers fire at the same boundaries as before;
 *   - construction validates SyncProfile.transport governance against the real
 *     EntityKindRegistry (makes `transport` load-bearing — boot-time, not hot).
 *
 * Byte-level encoding is the broadcasters' job (unchanged) and is covered by the
 * netgate + the existing integration suite; this locks the router's ORDERING +
 * GOVERNANCE precisely with fakes.
 */
import { describe, it, expect } from 'vitest';
import { EntitySyncRouter } from './EntitySyncRouter.js';
import type { SwarmBroadcaster } from './SwarmBroadcaster.js';
import type { SnapshotBroadcaster } from './SnapshotBroadcaster.js';

function makeRouter(idle: boolean) {
  const order: string[] = [];
  let receivedIdle: boolean | undefined;
  let idleCalls = 0;
  const swarm = { broadcast: () => order.push('swarm') } as unknown as SwarmBroadcaster;
  const snapshot = {
    broadcast: (i: boolean) => {
      order.push('snapshot');
      receivedIdle = i;
    },
  } as unknown as SnapshotBroadcaster;
  const router = new EntitySyncRouter({
    swarmBroadcaster: swarm,
    snapshotBroadcaster: snapshot,
    evaluateSectorIdle: () => {
      order.push('idle');
      idleCalls += 1;
      return idle;
    },
  });
  return { router, order, getIdle: () => receivedIdle, getIdleCalls: () => idleCalls };
}

describe('EntitySyncRouter.route — ordering (HC#4) + idle threading', () => {
  it('runs pose-core, then sector-idle, then json-slice — in that exact order', () => {
    const h = makeRouter(true);
    h.router.route(() => {});
    expect(h.order).toEqual(['swarm', 'idle', 'snapshot']);
  });

  it('evaluates sector-idle exactly once and threads the result into the json-slice send', () => {
    const h = makeRouter(false);
    h.router.route(() => {});
    expect(h.getIdleCalls()).toBe(1);
    expect(h.getIdle()).toBe(false);
  });

  it('fires the tick-budget phase markers at the same boundaries as the pre-router code', () => {
    const h = makeRouter(true);
    const phases: string[] = [];
    h.router.route((k) => phases.push(k));
    expect(phases).toEqual(['swarmEncode', 'swarmBroadcast', 'snapshotBroadcast']);
  });
});

describe('EntitySyncRouter — transport governance (makes SyncProfile.transport load-bearing)', () => {
  it('constructs without throwing for the real EntityKindRegistry (transport declarations are consistent)', () => {
    const swarm = { broadcast: () => {} } as unknown as SwarmBroadcaster;
    const snapshot = { broadcast: () => {} } as unknown as SnapshotBroadcaster;
    expect(
      () =>
        new EntitySyncRouter({
          swarmBroadcaster: swarm,
          snapshotBroadcaster: snapshot,
          evaluateSectorIdle: () => false,
        }),
    ).not.toThrow();
  });
});
