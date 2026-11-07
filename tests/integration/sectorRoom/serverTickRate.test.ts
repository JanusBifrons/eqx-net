/**
 * The server ticks at 60 Hz in wall-clock time with one pilot flying.
 *
 * Found 2026-11-07 while chasing jitter in the capital showcase clips: a
 * two-browser E2E on the laptop saw serverTick advance only ~25 ticks per
 * second. This measures the server alone (no browsers), so a failure here
 * is the server's own pace, not host load from the clients.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness';

describe('server tick rate', () => {
  let h: SectorTestHarness | null = null;
  afterEach(async () => { await h?.cleanup(); h = null; });

  it('advances ~60 ticks per wall-clock second with a pilot flying', async () => {
    h = await bootSectorTestServer({ testMode: true, asteroidConfig: [], droneCount: 0 });
    const room = await h.connectActive(randomUUID());
    // Wake the sector so it broadcasts.
    const thrust = setInterval(() => h?.sendThrust(room), 50);
    try {
      const first = await h.waitForSnapshot(room, 3000);
      const t0 = performance.now();
      await h.advance(3000);
      const last = await h.waitForSnapshot(room, 3000);
      const secs = (performance.now() - t0) / 1000;
      const hz = (last.serverTick - first.serverTick) / secs;
      console.log(`[serverTickRate] ${hz.toFixed(1)} Hz over ${secs.toFixed(2)} s`);
      expect(hz).toBeGreaterThan(55);
      expect(hz).toBeLessThan(65);
    } finally {
      clearInterval(thrust);
    }
  }, 20_000);
});
