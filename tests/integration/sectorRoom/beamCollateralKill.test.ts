/**
 * Weapon cuts, collateral kill (owner, 2026-11-16): "a missile frigate sat
 * exactly between two capitals that are fighting and the laser kills it by
 * accident. It's never locked or targeted. It just happens to be within the
 * beam."
 *
 * Room `showcase-beam-collateral` (showcaseWeaponCutsRooms.ts): your lance
 * battlecruiser (a scene `fleet` hull, AI-flown, Hunt + Aggressive) at the
 * origin, the enemy's lance battlecruiser (hostile to you) due north, head
 * on, and the enemy's missile frigate holding station side-on across the
 * line, 12 km from yours and 7.5 km from theirs. Run at 1x with the room's own scene
 * timings (the speed the showcase films at), so this is the shot's timeline.
 * Asserted within `BEAM_COLLATERAL.killWindowMs` game time of your capital's
 * arrival:
 *   1. your capital's heavy beams hit the ENEMY capital (laser_fired);
 *   2. nothing of yours ever locks the frigate or makes it the AI pilot's
 *      target (it is never the aim, only in the way);
 *   3. the frigate dies, and the killing hit is your capital's heavy beam.
 * Nothing bypasses lock-to-fire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_BEAM_COLLATERAL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import { BEAM_COLLATERAL } from '../../../src/server/rooms/showcaseWeaponCutsRooms.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';

type DamageFn = (t: string, s: string, d: number, hx?: number, hy?: number, dx?: number, dy?: number, w?: string) => boolean;

describe('SectorRoom integration — heavy-beam collateral kill (showcase-beam-collateral)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it("your capital's beam, laid on the enemy capital, kills the enemy's frigate in between", { timeout: 150_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_BEAM_COLLATERAL_OPTS) as unknown as Record<string, unknown>);
    const pid = randomUUID();
    const client = await harness.connectActive(pid, {});
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    const gameNow = (): number => room.gameClock.now();

    // The scene plays on the pilot's ready: your capital arrives at mineAtMs.
    let mine = '';
    for (let i = 0; i < 600 && mine === ''; i++) {
      await harness.advance(100);
      for (const s of state.ships.values()) {
        if (s.playerId === pid && s.kind === 'battlecruiser-lance' && internals.fleet.isAttached(s.shipInstanceId)) mine = s.shipInstanceId;
      }
    }
    expect(mine, 'your AI-flown capital').not.toBe('');
    const enemy = [...internals.swarmRegistry.all()].find((r) => r.shipKind === 'battlecruiser-lance');
    const frigate = [...internals.swarmRegistry.all()].find((r) => r.shipKind === 'missile-frigate');
    expect(enemy, 'the enemy capital').toBeDefined();
    expect(frigate, 'the enemy frigate').toBeDefined();
    const enemyWire = `swarm-${enemy!.entityId}`, frigateWire = `swarm-${frigate!.entityId}`;
    const frigateKey = `s:${frigate!.entityId}`;
    expect(internals.npcHostileTo(enemy!.id, pid), 'the enemy capital is hostile to you').toBe(true);
    expect(internals.npcHostileTo(frigate!.id, pid), 'the frigate is not (nobody aims at it)').toBe(false);

    // Every hit on the frigate, and your beams that hit the enemy capital.
    const r = room as unknown as { applyDamage: DamageFn };
    const orig = r.applyDamage.bind(room);
    const frigateHits: Array<{ shooter: string; weapon: string | undefined; killed: boolean }> = [];
    r.applyDamage = (t, s, d, hx, hy, dx, dy, w) => {
      const killed = orig(t, s, d, hx, hy, dx, dy, w);
      if (t === frigate!.id) frigateHits.push({ shooter: s, weapon: w, killed });
      return killed;
    };
    let beamsOnEnemy = 0;
    client.onMessage('laser_fired', (e: LaserFiredEvent) => { if (e.shooterId === mine && e.targetId === enemyWire) beamsOnEnemy++; });
    const arrived = gameNow();
    const aimedAtFrigate: string[] = [];
    let killedAt = -1;
    while (gameNow() - arrived < BEAM_COLLATERAL.killWindowMs) {
      for (const g of internals.locksOf(mine) ?? []) for (const l of g.l) if (l.t === frigateKey) aimedAtFrigate.push(`lock ${g.id}`);
      const tgt = internals.aiBrainOf(mine)?.getTargetId?.() ?? null;
      if (tgt === frigate!.id || tgt === frigateWire) aimedAtFrigate.push('brain target');
      if (killedAt < 0 && !internals.swarmHealth.has(frigate!.id)) killedAt = gameNow() - arrived;
      if (killedAt >= 0 && beamsOnEnemy > 0) break;
      await harness.advance(100);
    }
    const killing = frigateHits.find((h) => h.killed);
    const mp = internals.lingeringPoseCache.get(mine), ep = internals.swarmPose(enemy!.id);
    console.log(`[collateral] frigate down ${killedAt < 0 ? 'never' : `${(killedAt / 1000).toFixed(1)} s game after your capital arrived`}; `
      + `killer ${killing ? `${killing.shooter === mine ? 'YOUR CAPITAL' : killing.shooter} ${killing.weapon}` : 'none'}; `
      + `frigate hits ${frigateHits.length} (by ${[...new Set(frigateHits.map((h) => `${h.shooter === mine ? 'mine' : h.shooter}:${h.weapon}`))].join(',')}); `
      + `your beams on the enemy ${beamsOnEnemy}; mine at (${mp?.x.toFixed(0)}, ${mp?.y.toFixed(0)}), enemy at (${ep?.x.toFixed(0)}, ${ep?.y.toFixed(0)})`);

    expect(aimedAtFrigate, 'the frigate was locked or targeted').toEqual([]);
    expect(killedAt, 'the frigate died inside the window').toBeGreaterThanOrEqual(0);
    expect(killing, 'a hit killed the frigate').toBeDefined();
    expect(killing!.shooter, 'killed by your capital').toBe(mine);
    expect(killing!.weapon, 'with its heavy beam').toBe('heavy_beam');
    expect(beamsOnEnemy, 'your heavy beams hit the enemy capital').toBeGreaterThan(0);
    await harness.disconnectClient(client);
  });
});
