/**
 * weapon-hit-prediction Phase 4 — the server `hit_ack` ↔ `DamageEvent`
 * contract lock (real `handleFire` path).
 *
 * The client-side hit-prediction de-dupes a confirmed predicted number
 * against the authoritative `DamageEvent` ONLY because the server
 * guarantees, for a hit fire:
 *
 *   hit_ack.damage   === the subsequent DamageEvent.damage   (Phase 0)
 *   hit_ack.targetId === the subsequent DamageEvent.targetId  (Phase 3)
 *
 * Both values are produced by two SEPARATE code paths inside the room
 * (`handleFire`'s aggregate ack vs `applyDamage`'s broadcast), so only an
 * end-to-end test through the real fire pipeline can lock them together.
 * `applyDamage` alone never produces a `hit_ack`, so — unlike every other
 * combat integration test — this one must drive a real `fire` message.
 *
 * Determinism: a player spawns at a fixed pose with **angle 0**
 * (`SectorRoom` seeds `shipPoseCache` angle 0 at spawn) so its fire
 * forward vector is exactly +Y. `spawnX`/`spawnY` join opts place a second
 * player squarely on that ray, and the server's lag-comp falls back to the
 * deterministic spawn `shipPoseCache` pose — no fragile geometry.
 *
 * Scope: the player target exercises the full real fire→ack/damage
 * contract incl. the targetId-equality invariant generically (a
 * `bestHitWireId` regression fails this for ANY class). The swarm-specific
 * wire-id mapping (`rec.id` → `swarm-<entityId>`) is locked by the Phase-3
 * unit reconcile tests and exercised by the Phase-5 E2E; a real
 * drone-target fire would need a position-controlled drone spawn the
 * harness doesn't offer, and a moving-drone aim would be flaky — a
 * non-repeatable integration test does not protect future PRs
 * (src/server/CLAUDE.md testing policy).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

const HITSCAN_DAMAGE = getWeapon('hitscan').damage;

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — hit_ack ↔ DamageEvent contract (weapon-hit-prediction Phase 4)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a hit fire: hit_ack.damage === DamageEvent.damage AND hit_ack.targetId === DamageEvent.targetId', async () => {
    const shooterPid = randomUUID();
    const targetPid = randomUUID();

    // Shooter at origin, angle 0 → forward = +Y.
    const shooter = (await harness.connectAs(shooterPid, {
      shipKind: 'fighter',
      spawnX: 0,
      spawnY: 0,
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooterPid });

    // Target squarely on the +Y ray, well inside HITSCAN_RANGE (500) and
    // clear of the 20 u barrel + self radius.
    await harness.connectAs(targetPid, { shipKind: 'fighter', spawnX: 0, spawnY: 120 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === targetPid });

    const hitAcks: Array<Record<string, unknown>> = [];
    const damages: Array<Record<string, unknown>> = [];
    shooter.onMessage('hit_ack', (m: Record<string, unknown>) => hitAcks.push(m));
    shooter.onMessage('damage', (m: Record<string, unknown>) => damages.push(m));

    // Let the server tick a few times so BOTH ships are recorded into the
    // SnapshotRing / shipPoseCache (onJoin only pre-seeds the SAB slot; the
    // lag-comp pose the hitscan reads is filled by the per-tick update()
    // loop). Zero input ⇒ the ships stay exactly at their spawn poses.
    await harness.advance(300);

    const serverTick = (harness.getServerRoom() as unknown as { serverTick: number }).serverTick;
    const clientShotId = 'ct-phase4-hit';
    shooter.send('fire', {
      type: 'fire',
      tick: serverTick,
      clientShotId,
      weapon: 'hitscan',
      dirAngle: 0,
    });

    await waitUntil(
      () => hitAcks.some((a) => a['clientShotId'] === clientShotId) && damages.some((d) => d['targetId'] === targetPid),
      2500,
      'hit_ack + damage for the target',
    );

    const ack = hitAcks.find((a) => a['clientShotId'] === clientShotId)!;
    const dmg = damages.find((d) => d['targetId'] === targetPid)!;

    expect(ack['hit']).toBe(true);
    // Phase 3 — both client-facing messages speak the same id space.
    expect(ack['targetId']).toBe(targetPid);
    expect(dmg['targetId']).toBe(targetPid);
    expect(ack['targetId']).toBe(dmg['targetId']);
    // Phase 0 — the de-dupe contract: the ack's damage is exactly what the
    // authoritative DamageEvent carries (so a confirmed prediction replaces,
    // never double-counts).
    expect(ack['damage']).toBe(HITSCAN_DAMAGE);
    expect(dmg['damage']).toBe(HITSCAN_DAMAGE);
    expect(ack['damage']).toBe(dmg['damage']);
  }, 20_000);

  it('a miss fire: hit_ack.hit === false, NO damage field, NO DamageEvent (damage rides only hit:true)', async () => {
    const shooterPid = randomUUID();
    const shooter = (await harness.connectAs(shooterPid, {
      shipKind: 'fighter',
      spawnX: 0,
      spawnY: 0,
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooterPid });

    const hitAcks: Array<Record<string, unknown>> = [];
    const damages: Array<Record<string, unknown>> = [];
    shooter.onMessage('hit_ack', (m: Record<string, unknown>) => hitAcks.push(m));
    shooter.onMessage('damage', (m: Record<string, unknown>) => damages.push(m));

    await harness.advance(300); // symmetry with the hit test (ring-recorded shooter)

    const serverTick = (harness.getServerRoom() as unknown as { serverTick: number }).serverTick;
    const clientShotId = 'ct-phase4-miss';
    // Fire into empty space (no target on the +Y ray; droneCount 0).
    shooter.send('fire', {
      type: 'fire',
      tick: serverTick,
      clientShotId,
      weapon: 'hitscan',
      dirAngle: 0,
    });

    await waitUntil(() => hitAcks.some((a) => a['clientShotId'] === clientShotId), 2500, 'miss hit_ack');
    // Give any (erroneous) damage broadcast a chance to arrive too.
    await harness.advance(150);

    const ack = hitAcks.find((a) => a['clientShotId'] === clientShotId)!;
    expect(ack['hit']).toBe(false);
    expect(ack['damage']).toBeUndefined();
    expect(damages.length).toBe(0);
  }, 20_000);

  // Shot-rejected fix (capture 2026-05-19T11-22-22-628Z-uf0o8g): a fire
  // whose claimed tick is far behind serverTick (the client's input
  // clock lagged after a stall) used to be HARD-REJECTED — ~37% of a
  // laggy client's shots silently dropped. It must now be CLAMPED to the
  // lag-comp window floor and RESOLVED, not rejected. End-to-end wiring
  // lock; the decision canary is src/core/combat/fireTemporal.test.ts.
  it('a STALE-tick fire (tick << serverTick) is honored (clamped+resolved), NOT rejected', async () => {
    const shooterPid = randomUUID();
    const targetPid = randomUUID();
    const shooter = (await harness.connectAs(shooterPid, {
      shipKind: 'fighter',
      spawnX: 0,
      spawnY: 0,
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooterPid });
    await harness.connectAs(targetPid, { shipKind: 'fighter', spawnX: 0, spawnY: 120 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === targetPid });

    const hitAcks: Array<Record<string, unknown>> = [];
    const damages: Array<Record<string, unknown>> = [];
    shooter.onMessage('hit_ack', (m: Record<string, unknown>) => hitAcks.push(m));
    shooter.onMessage('damage', (m: Record<string, unknown>) => damages.push(m));
    // Tick the fresh server well past 100 so `serverTick - 100` is a
    // POSITIVE stale tick (a fresh test sector starts serverTick≈0; the
    // real client's is in the hundred-thousands). A negative tick would
    // fail the FireMessage zod schema and never reach handleFire.
    await harness.advance(2500);

    const serverTick = (harness.getServerRoom() as unknown as { serverTick: number }).serverTick;
    expect(serverTick).toBeGreaterThan(120); // precondition: enough ticks elapsed
    const clientShotId = 'ct-stale-tick';
    // 100 ticks behind — far past LAG_COMP_WINDOW (12); the capture saw
    // rejected runs out to ~420 behind. Stationary shooter ⇒ the clamped
    // (oldest-ring) pose still resolves the +Y ray onto the target.
    shooter.send('fire', {
      type: 'fire',
      tick: serverTick - 100,
      clientShotId,
      weapon: 'hitscan',
      dirAngle: 0,
    });

    await waitUntil(
      () => hitAcks.some((a) => a['clientShotId'] === clientShotId),
      2500,
      'hit_ack for the stale-tick fire',
    );
    const ack = hitAcks.find((a) => a['clientShotId'] === clientShotId)!;
    // The whole point: NOT rejected, and it actually resolved as a hit.
    expect(ack['rejected']).toBeFalsy();
    expect(ack['hit']).toBe(true);
    expect(ack['targetId']).toBe(targetPid);
    await waitUntil(
      () => damages.some((d) => d['targetId'] === targetPid),
      2000,
      'DamageEvent for the stale-tick fire',
    );
  }, 20_000);
});
