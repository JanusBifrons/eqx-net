/**
 * Macro terrain C3: a broken-up cut-field rock (`markConsumed`, the salvage
 * rock cut's call) reaches every client: a live one hears `field_consumed`
 * once, a joiner gets it in the welcome's `cutField.consumed` (#16), and the
 * server never cuts the rock whole again. C4: a room that saves its sector
 * writes the break to `terrain_records` (TERRAIN_RECORD_PUT); one without a
 * sector key writes nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { FIELD_LAYOUT_VERSION } from '../../../src/core/terrain/fieldLayout.js';
import { FieldConsumedSchema, WelcomeSchema } from '../../../src/shared-types/messages/snapshotMessages.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — consumed cut-field rocks (C3)', () => {
  it('a live client hears the break and a joiner gets it in the welcome', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const live = await harness.connectAs(randomUUID());
    const heard: unknown[] = [];
    live.onMessage('field_consumed', (m: unknown) => { heard.push(m); });
    live.send('client_ready', { type: 'client_ready' });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = room._internals;
    let rock: { id: string; fieldKey?: number } | undefined;
    const deadline = Date.now() + 20_000;
    while (!rock && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all()) if (r.fieldRock === true) { rock = r; break; }
    }
    expect(rock?.fieldKey, 'a field rock streamed in').toBeTypeOf('number');
    const key = rock!.fieldKey!;

    int.cutFieldSub!.markConsumed(key);
    int.cutFieldSub!.markConsumed(key); // once only
    await harness.advance(200);
    expect(heard).toEqual([{ k: key }]);
    expect(FieldConsumedSchema.safeParse(heard[0]).success).toBe(true);
    // No sector key: nothing to save under (C4).
    expect(harness.sink.ops.filter((o) => o.type === 'TERRAIN_RECORD_PUT')).toEqual([]);

    const joiner = await harness.connectAs(randomUUID());
    let welcome: unknown;
    joiner.onMessage('welcome', (m: unknown) => { welcome = m; });
    joiner.send('client_ready', { type: 'client_ready' });
    const until = Date.now() + 10_000;
    while (welcome === undefined && Date.now() < until) await harness.advance(100);
    const parsed = WelcomeSchema.safeParse(welcome);
    expect(parsed.success, 'the welcome passes the client schema').toBe(true);
    expect((welcome as { cutField?: { seed: string; consumed?: number[] } }).cutField).toEqual({ seed: 'look', consumed: [key] });
  });

  it('a galaxy sector saves the break to terrain_records (C4)', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const live = await harness.connectAs(randomUUID());
    live.send('client_ready', { type: 'client_ready' });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    let rock: { id: string; fieldKey?: number } | undefined;
    const deadline = Date.now() + 20_000;
    while (!rock && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all()) if (r.fieldRock === true) { rock = r; break; }
    }
    expect(rock?.fieldKey, 'a field rock streamed in').toBeTypeOf('number');
    int.cutFieldSub!.markConsumed(rock!.fieldKey!);
    const puts = harness.sink.ops.filter((o) => o.type === 'TERRAIN_RECORD_PUT');
    expect(puts).toEqual([{ type: 'TERRAIN_RECORD_PUT', sectorKey: 'sol-prime|look', rockKey: rock!.fieldKey, layoutVersion: FIELD_LAYOUT_VERSION, pool: null, consumed: true, pose: null, ts: expect.any(Number) }]);
  });
});
