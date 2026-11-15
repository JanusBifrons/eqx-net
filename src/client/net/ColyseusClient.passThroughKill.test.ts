/**
 * A railgun PASS-THROUGH kill dies when the drawn slug reaches it (hostile
 * review of rail take 7, 2026-11-15, built WITH the deferred-kill fix):
 * "the heavy cruiser killed by the pass-through slug still splits ~6 frames
 * before the drawn slug reaches it (number at f301, split at f302-303 while
 * the slug is ~75 px out; slug at the hull ~f308). The light cruiser, where
 * the slug stops, is timed right."
 *
 * Why it survived `ColyseusClient.shellKillTiming.test.ts` (#13: this test
 * sits a level up, on the take's REAL victim and message sequence): that test
 * killed a swarm entry. In the rail-channel take the heavy cruiser is the
 * PILOT's own hull, parked when the pilot spectates (a lingering hull,
 * `mirror.lingeringShips`, keyed by shipInstanceId); the light cruiser is an
 * AI ship (swarm). A `destroy` for a non-swarm id went straight to
 * `killEntity` (explosion + held number at once), and the next snapshot,
 * which no longer lists the hull, evicted it (`routeSnapshotShipStates`):
 * both on the ARRIVAL timeline, ~DISPLAY_DELAY_MS + RTT/2 (6 frames) ahead
 * of the drawn slug. `continues: 1` was not the cause: its tuple matches the
 * held hit like a final one.
 *
 * A second, smaller lead: a shell_end's tick is the server step's START
 * (the step at tick S sweeps the shell from its pose at S to S + 1), so at
 * display tick S the drawn slug is still up to one step (~107 u for the
 * slug) short of the hit. The kill (and the burst) wait for the fraction of
 * the step the hit lies along (`shellHitTick`).
 *
 * The sequence below is the server's order for one slug: shell_salvo; much
 * later one flush with damage(A), destroy(A), shell_end [A continues]; then
 * snapshots without A; frames on the shell display clock (`placeShells`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import { useUIStore } from '../state/store.js';
import type { DamageEvent, DestroyEvent, SnapshotMessage } from '../../shared-types/messages.js';
import type { ShellEnd, ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import type { ProjectileRenderState } from '../../core/contracts/IRenderer.js';

interface Internals {
  mirror: {
    ships: Map<string, unknown>;
    lingeringShips?: Map<string, { x: number; y: number }>;
    explodingShips?: Set<string>;
    projectiles?: Map<string, ProjectileRenderState>;
    pendingDamageNumbers?: Array<{ targetId: string; damage: number }>;
    pendingHealthBarHits?: unknown[];
    pendingEffectTriggers?: unknown[];
    pendingShellEnds?: number[];
    wreckRevealFromTick?: number;
    localPlayerId: string | null;
  };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  clockAnchorServerTick: number;
  handleSnapshot(snap: SnapshotMessage): void;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  handleDestroy(evt: DestroyEvent): void;
  applyShellEnd(msg: ShellEnd): void;
  placeShells(displayTick: number): void;
}

const HULL = 'ship-hc'; // the pilot's parked heavy cruiser (shipInstanceId)
// A slug from x = 0 at 6,000 u/s (100 u/tick), fired at tick 1000. The step
// at tick 1010 sweeps it from x = 1000 to 1100; it meets the parked hull at
// x = 1050, kills it and flies on (the drawn slug reaches x = 1050 at 1010.5).
const SALVO: ShellSalvo = {
  type: 'shell_salvo', s: 1, o: 'swarm-3', w: 'railgun', t: 1000, n: 600,
  sh: [['slug-1', 0, 0, 6000, 0]],
};
const HIT_X = 1050;
const KILL: DamageEvent = {
  type: 'damage', targetId: HULL, damage: 7860, newHealth: 0, shooterId: 'swarm-3',
  hitX: HIT_X, hitY: 0, newShield: 0, shieldMax: 1000, hullMax: 6000, hitLayer: 'hull',
};
const DESTROY: DestroyEvent = { type: 'destroy', targetId: HULL, shooterId: 'swarm-3' };
const PASS_END: ShellEnd = { type: 'shell_end', e: [['slug-1', 1010, HIT_X, 0, 0, 1]] };

function snapshot(tick: number, withHull: boolean): SnapshotMessage {
  const states: SnapshotMessage['states'] = {};
  if (withHull) states[HULL] = { x: 1100, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'me', isActive: false };
  return { type: 'snapshot', serverTick: tick, states, ackedTick: 0 };
}

describe('a pass-through kill on a parked pilot hull waits for the drawn slug', () => {
  let c: Internals;

  beforeEach(() => {
    useUIStore.getState().setPilotMode('spectator');
    c = new ColyseusGameClient(new MockClock(50_000)) as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.mirror.explodingShips = new Set();
    c.mirror.projectiles = new Map();
    c.mirror.pendingDamageNumbers = [];
    c.mirror.pendingHealthBarHits = [];
    c.mirror.pendingEffectTriggers = [];
    c.mirror.pendingShellEnds = [];
    c._shellEvents = true;
    // The parked hull, from the snapshots before the shot.
    c.handleSnapshot(snapshot(1006, true));
    expect(c.mirror.lingeringShips!.has(HULL)).toBe(true);
    c._shellStore.applySalvo(SALVO);
  });

  it('hull, explosion and number wait for the drawn slug, then go on the frame it reaches the hull', () => {
    // One server flush at tick 1010: damage, destroy, then the shell_end.
    c.handleDamage(KILL);
    c.handleDestroy(DESTROY);
    c.applyShellEnd(PASS_END);
    // The next snapshots no longer list the dead hull.
    c.handleSnapshot(snapshot(1012, false));
    c.clockAnchorServerTick = 1012;
    const slugX = (): number => c.mirror.projectiles!.get('slug-1')!.x;
    let died = -1;
    // Frames on the display clock, ~6 ticks behind the arrival.
    for (let f = 0; f <= 16; f++) {
      const displayTick = 1004 + f * 0.5;
      c.placeShells(displayTick);
      const alive = c.mirror.lingeringShips!.has(HULL);
      const exploding = c.mirror.explodingShips!.has(HULL);
      const numbers = c.mirror.pendingDamageNumbers!.length;
      if (died < 0 && (!alive || exploding || numbers > 0)) {
        died = displayTick;
        expect(slugX(), `display ${displayTick}: the hull died with the drawn slug short of it`).toBeGreaterThanOrEqual(HIT_X - 1);
        expect(alive, 'the hull goes in the explosion frame').toBe(false);
        expect(exploding).toBe(true);
        expect(numbers, 'the number comes with the explosion').toBe(1);
        expect(c.mirror.wreckRevealFromTick, 'its wreck pieces show from now').toBeUndefined();
      }
      if (died < 0) {
        expect(c.mirror.wreckRevealFromTick, 'its new wreck pieces wait').toBeDefined();
        c.handleSnapshot(snapshot(1012 + f, false)); // still not listed: still drawn
        c.clockAnchorServerTick = 1012;
      }
    }
    expect(died, 'it died once the drawn slug reached it').toBe(1010.5);
    // The slug flew on.
    expect(c.mirror.projectiles!.has('slug-1')).toBe(true);
  });
});
