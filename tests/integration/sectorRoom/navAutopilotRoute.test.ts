/**
 * Navigation slice 12: a player's autopilot asks the room for a route
 * (`nav_route_request`) across rock and gets the nav worker's route back for
 * its own hull, to it alone; a second ask straight after is dropped (rate);
 * a malformed one is dropped and counted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { crossing } from './navCrossing.js';
import { NavRouteReplySchema, type NavRouteReply } from '../../../src/shared-types/messages/navMessages.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; }, 10_000);

describe('nav_route_request (navigation slice 12)', () => {
  it('answers the asker with a route round the rock ending at the goal; an ask straight after is dropped', async () => {
    const at = crossing();
    harness = await bootSectorTestServer({ sectorKey: null, testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
    const client = await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: Math.round(at.ax), spawnY: Math.round(at.ay) });
    const replies: NavRouteReply[] = [];
    client.onMessage('nav_route', (m: unknown) => { replies.push(NavRouteReplySchema.parse(m)); });
    await harness.advance(1_500); // chunks round the hull load; the nav worker builds both layers
    client.send('nav_route_request', { type: 'nav_route_request', reqId: 1, tx: Math.round(at.bx), ty: Math.round(at.by) });
    client.send('nav_route_request', { type: 'nav_route_request', reqId: 2, tx: Math.round(at.bx), ty: Math.round(at.by) });
    client.send('nav_route_request', { type: 'nav_route_request', reqId: 3, tx: 'far' });
    for (let i = 0; i < 40 && replies.length === 0; i++) await harness.advance(50);
    await harness.advance(300);
    expect(replies.map((r) => r.reqId)).toEqual([1]);
    const r = replies[0]!;
    expect(r.status).toBe('route');
    expect(r.points.length).toBeGreaterThanOrEqual(4); // a turn round the rock, then the goal
    expect(r.points.at(-2)).toBeCloseTo(Math.round(at.bx), 0);
    expect(r.points.at(-1)).toBeCloseTo(Math.round(at.by), 0);
  });
});
