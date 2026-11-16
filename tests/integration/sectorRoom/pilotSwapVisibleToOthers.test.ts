/**
 * RTS Part A — seamless take controls, seen by OTHER players (two-sided).
 *
 * Owner requirement: when another player takes the controls of their parked
 * ship, it must not flicker on my screen. The server reclaims the hull through
 * the join handshake (`pendingJoin`, `isActive=false` until `client_ready` ->
 * arrival). A ship still JOINING was sent to its own pilot only, so for every
 * observer the parked hull (already in the world, already drawn) vanished from
 * the snapshots for the whole handshake: the observer's client dropped it and
 * then built it again as an active ship (e2e `rts-take-controls.spec.ts`, "another
 * pilot taking their parked ship's controls", sprite rebuilt). A reclaimed hull
 * is already in the world, so it stays in every snapshot through the
 * handshake; the client then MOVES it to its pilot's key (`rekeyShip`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

describe('take controls: the reclaimed hull stays visible to other players', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('every observer snapshot through the handshake carries the hull, then it turns active', async () => {
    const PID_A = randomUUID();
    const PID_B = randomUUID();
    // A parks hull X in the world (disconnect -> linger -> come back in a new ship).
    const a1 = await harness.connectActive(PID_A, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const state = harness.getServerRoom()!.state as SectorState;
    let shipX = '';
    for (const [, s] of state.ships) if (s.playerId === PID_A && s.isActive) { shipX = s.shipInstanceId; break; }
    expect(shipX).not.toBe('');
    await harness.disconnectClient(a1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    const a2 = await harness.connectActive(PID_A, { isNewShip: true, shipKind: 'fighter', spawnX: 600, spawnY: 600 });

    const b = await harness.connectActive(PID_B, { spawnX: 300, spawnY: 0, shipKind: 'fighter' });
    await harness.advance(200);
    let seen = 0;
    let missing = 0;
    let activeSeen = false;
    b.onMessage('snapshot', (raw: unknown) => {
      const s = raw as SnapshotMessage;
      const e = s.states[shipX];
      if (e === undefined) { missing++; return; }
      seen++;
      if (e.isActive) activeSeen = true;
    });

    // A takes X's controls; hold the handshake open (no client_ready yet).
    a2.send('pilot_ship', { type: 'pilot_ship', shipId: shipX });
    await harness.advance(500);
    expect(seen, 'B kept getting the hull while A joins it').toBeGreaterThan(0);
    expect(missing, 'B never got a snapshot without the hull').toBe(0);

    a2.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);
    expect(activeSeen, 'then B sees it active').toBe(true);
    expect(missing).toBe(0);

    await harness.disconnectClient(a2);
    await harness.disconnectClient(b);
  }, 30_000);
});
