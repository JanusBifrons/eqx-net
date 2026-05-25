/**
 * Phase 1 (plan: wrap-up-known-issues) — combat-event diagnosis lock.
 *
 * Smoke capture `2026-05-19T13-43-06-710Z-76idw1` recorded a kill + shield
 * break (`population.bot_respawn`, `other.shield_broken`) yet NOT ONE
 * `damage` / `hit_ack` / `destroy` event in ANY ndjson — only `fire` /
 * `fire_received`. The combat funnel after "shot accepted" was invisible,
 * so invariant-#13 repro-first on the inconsistent-damage + explosion bugs
 * was BLOCKED.
 *
 * This drives the REAL fire→hit→destroy pipeline and asserts the server
 * now emits `damage`, `hit_ack`, and `destroy` through `serverLogEvent`
 * (the same ring `fire_received` rides), with the ids+scalars shape and
 * NO position/velocity data (Pino policy). The routing-table half of the
 * fix is locked separately by `diagRouter.test.ts` (routeBucket → combat).
 *
 * Determinism mirrors `hitAckContract.test.ts`: shooter at origin angle 0
 * (forward = +Y), a low-hull `scout` (maxHealth 90) squarely on the +Y ray
 * so a sustained beam burst deterministically reaches the destroy. Player
 * target only — the harness cannot position a drone (documented there);
 * asteroids emit no `damage` so they are deliberately excluded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — combat diagnostics coverage (Phase 1)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('emits damage + hit_ack + destroy diag events through the real fire pipeline', async () => {
    const shooterPid = randomUUID();
    const targetPid = randomUUID();

    const shooter = (await harness.connectAs(shooterPid, {
      shipKind: 'fighter',
      spawnX: 0,
      spawnY: 0,
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooterPid });

    // scout: maxHealth 90 — the lowest-hull kind, so a sustained beam
    // burst overruns shield regen and reaches `destroy` quickly.
    await harness.connectAs(targetPid, { shipKind: 'scout', spawnX: 0, spawnY: 120 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === targetPid });

    // Both ships into SnapshotRing / shipPoseCache before firing (onJoin
    // only pre-seeds the SAB slot — see hitAckContract.test.ts).
    await harness.advance(300);

    // Sustained beam burst until the target is destroyed (outcome-gated,
    // never tick-count-asserted — DETERMINISM.md). Each fire claims a tick
    // 12 past the previous (> WEAPON_COOLDOWN_TICKS=10) so EVERY shot is
    // accepted regardless of how fast the sim ticks under test load — a
    // raw `serverTick` claim would cooldown-reject most shots whenever the
    // in-process sim runs below wall-clock and the kill would flake.
    // Slightly-ahead ticks pass temporal plausibility unchanged (future
    // claims resolve against the live pose; both ships are stationary).
    // scout = 90 shield + 90 hull, 20/hit ⇒ ~11 accepted hits to kill;
    // 30 iters is ample headroom and the loop exits early on destroy.
    const baseTick = (harness.getServerRoom() as unknown as { serverTick: number }).serverTick;
    let destroyed = false;
    for (let i = 0; i < 30 && !destroyed; i++) {
      shooter.send('fire', {
        type: 'fire',
        tick: baseTick + i * 12,
        clientShotId: `ct-diag-${i}`,
        weapon: 'hitscan',
        dirAngle: 0,
      });
      await harness.advance(50);
      destroyed = harness.events.count({ tag: 'destroy', where: (d) => d['targetId'] === targetPid }) > 0;
    }

    const damages = harness.events.all({ tag: 'damage', where: (d) => d['targetId'] === targetPid });
    const hitAcks = harness.events.all({ tag: 'hit_ack' });
    const destroys = harness.events.all({ tag: 'destroy', where: (d) => d['targetId'] === targetPid });

    expect(damages.length).toBeGreaterThan(0);
    expect(hitAcks.length).toBeGreaterThan(0);
    expect(destroys.length).toBeGreaterThan(0);

    // Shape: ids + scalars, mirroring fire_received. NO position/velocity
    // in the diag entry (Pino policy — the `damage` WIRE payload carries
    // hitX/hitY for the client, but the diagnostic log must not).
    const dmg = damages[0]!.data;
    expect(typeof dmg['targetId']).toBe('string');
    expect(dmg['targetId']).toBe(targetPid);
    expect(typeof dmg['shooterId']).toBe('string');
    expect(typeof dmg['damage']).toBe('number');
    expect(dmg['hitX']).toBeUndefined();
    expect(dmg['hitY']).toBeUndefined();

    const ack = hitAcks[0]!.data;
    expect(typeof ack['shooterId']).toBe('string');
    expect('hit' in ack).toBe(true);

    expect(destroys[0]!.data['targetId']).toBe(targetPid);
  }, 30_000);
});
