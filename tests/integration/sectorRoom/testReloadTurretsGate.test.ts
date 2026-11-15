/**
 * Integration lock — the `test_reload_turrets` cue is testMode-only.
 *
 * The cue reloads every structure gun at once. A production client must not be
 * able to use it, so a non-testMode room ignores it; a testMode room honours it
 * (the positive control proves the gate is the only difference). The handler
 * lives in `TestMessageHandlers.ts`; this locks its gate at the room layer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { StructureGridSubsystem } from '../../../src/server/structures/StructureGridSubsystem.js';

describe('SectorRoom integration — test_reload_turrets is testMode-only', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('IGNORES the cue on a non-testMode room', async () => {
    const reload = vi.spyOn(StructureGridSubsystem.prototype, 'reloadAllTurrets');
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: false });
    const cr = await harness.connectAs(randomUUID());
    cr.send('test_reload_turrets', { type: 'test_reload_turrets' });
    await harness.advance(300);
    expect(reload).not.toHaveBeenCalled();
  }, 15_000);

  it('HONOURS the cue on a testMode room', async () => {
    const reload = vi.spyOn(StructureGridSubsystem.prototype, 'reloadAllTurrets');
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
    const cr = await harness.connectAs(randomUUID());
    cr.send('test_reload_turrets', { type: 'test_reload_turrets' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3_000, interval: 25 });
  }, 15_000);
});
