/**
 * A vaporised death stays vaporised when it is held for a drawn shell
 * (film review of beam-vaporise-subcap, 2026-11-15): "the missile frigate
 * (the pilot's parked hull) killed by the heavy beam just disappears inside
 * orange 5" smoke: no violet vaporise flash, no ash".
 *
 * Why: the battlecruiser's 5" secondaries fire at the same frigate from the
 * same hull as its heavy beam, so the beam's hit point lies on a live 5"
 * shell's path and `NavalHitHold.maybeHold` holds the beam's KILLING hit by
 * position. The `destroy` (`vaporised: true`) is then deferred
 * (`DrawnShellTiming.deferKill`), and `handleDestroy` put the id in the
 * one-frame `mirror.vaporisedShips` at once. `laser_fired` (a separate
 * message, so a render frame can fall between) releases the hit and the
 * kill; any render frame before that (`consumeOneFrameTriggers`) cleared
 * `vaporisedShips`, so the renderer saw an ordinary death in the
 * `explodingShips` frame. The same holds for any vaporised death held for a
 * drawn shell.
 *
 * Contract: on the frame a held death is released, `vaporisedShips` has the
 * id exactly when the destroy said `vaporised`, alongside `explodingShips`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import { useUIStore } from '../state/store.js';
import { consumeOneFrameTriggers } from '../render/perFrameTriggers.js';
import type { DamageEvent, DestroyEvent, LaserFiredEvent, SnapshotMessage } from '../../shared-types/messages.js';
import type { ShellEnd, ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import type { ProjectileRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';

interface Internals {
  mirror: {
    ships: Map<string, unknown>;
    swarm?: Map<number, SwarmRenderState>;
    explodingShips?: Set<string>;
    vaporisedShips?: Set<string>;
    projectiles?: Map<string, ProjectileRenderState>;
    pendingDamageNumbers?: Array<{ targetId: string; damage: number }>;
    pendingHealthBarHits?: unknown[];
    pendingEffectTriggers?: unknown[];
    pendingShellEnds?: number[];
    localPlayerId: string | null;
  };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  _shellTiming: { onBeamFired(evt: LaserFiredEvent): void };
  clockAnchorServerTick: number;
  handleSnapshot(snap: SnapshotMessage): void;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  handleDestroy(evt: DestroyEvent): void;
  applyShellEnd(msg: ShellEnd): void;
  placeShells(displayTick: number): void;
}

const HULL = 'ship-mf'; // the pilot's parked missile frigate (shipInstanceId)
const AI = 'swarm-7'; // an AI ship
// 5" shells from the battlecruiser at x = 0, 50 u/tick, fired at 990, along
// y = 0 (g-1) toward the target at x = 1050; it reaches it at tick 1011.
const GUNS: ShellSalvo = {
  type: 'shell_salvo', s: 2, o: 'swarm-3', w: 'naval_s', t: 990, n: 600,
  sh: [['g-1', 0, 0, 3000, 0]],
};

function kill(targetId: string): DamageEvent {
  return {
    type: 'damage', targetId, damage: 260, newHealth: 0, shooterId: 'swarm-3',
    hitX: 1050, hitY: 0, newShield: 0, shieldMax: 1000, hullMax: 6000, hitLayer: 'hull',
  };
}
function vaporise(targetId: string): DestroyEvent {
  return { type: 'destroy', targetId, shooterId: 'swarm-3', vaporised: true };
}
/** The heavy beam's `laser_fired`, ending at the hit point (on g-1's path). */
function beam(targetId: string): LaserFiredEvent {
  return {
    type: 'laser_fired', shooterId: 'swarm-3', mountId: 'beam-1',
    fromX: 0, fromY: 0, toX: 1050, toY: 0, hit: true, targetId,
  };
}
function snapshot(tick: number, withHull: boolean): SnapshotMessage {
  const states: SnapshotMessage['states'] = {};
  if (withHull) states[HULL] = { x: 1050, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, playerId: 'me', isActive: false };
  return { type: 'snapshot', serverTick: tick, states, ackedTick: 0 };
}
function frigate(): SwarmRenderState {
  return {
    x: 1050, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 60, kind: 1, shipKind: 'missile-frigate',
    poseRing: [], ringHead: 0, sleeping: false, lastUpdateTick: 1008,
  } as unknown as SwarmRenderState;
}

describe('a vaporised death held for a drawn shell is still vaporised when it is released', () => {
  let c: Internals;
  /** One rendered frame: the renderer reads the one-frame triggers, then
   *  they are consumed (gameRafLoop order). Records what it saw for `id`. */
  let seen: { exploding: boolean; vaporised: boolean } | null;
  function renderFrame(id: string): void {
    const exploding = c.mirror.explodingShips!.has(id);
    if (exploding && seen === null) seen = { exploding, vaporised: c.mirror.vaporisedShips!.has(id) };
    consumeOneFrameTriggers(c.mirror as Parameters<typeof consumeOneFrameTriggers>[0], true);
  }

  beforeEach(() => {
    useUIStore.getState().setPilotMode('spectator');
    c = new ColyseusGameClient(new MockClock(50_000)) as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.mirror.swarm = new Map([[7, frigate()]]);
    c.mirror.explodingShips = new Set();
    c.mirror.vaporisedShips = new Set();
    c.mirror.projectiles = new Map();
    c.mirror.pendingDamageNumbers = [];
    c.mirror.pendingHealthBarHits = [];
    c.mirror.pendingEffectTriggers = [];
    c.mirror.pendingShellEnds = [];
    c._shellEvents = true;
    c.handleSnapshot(snapshot(1006, true));
    expect(c.mirror.ships.has(HULL)).toBe(true);
    c.clockAnchorServerTick = 1010;
    c._shellStore.applySalvo(GUNS);
    seen = null;
  });

  for (const [who, id] of [['the pilot\'s parked hull', HULL], ['an AI ship', AI]] as const) {
    it(`${who}: a heavy-beam kill held by position, a frame before its laser_fired`, () => {
      c.handleDamage(kill(id)); // on g-1's path: held
      c.handleDestroy(vaporise(id)); // deferred
      c.placeShells(1004);
      renderFrame(id); // a render frame between the destroy and laser_fired
      expect(seen, 'not dead yet').toBeNull();
      c._shellTiming.onBeamFired(beam(id)); // releases the hit and the kill
      renderFrame(id);
      expect(seen, 'it died on the laser_fired frame').not.toBeNull();
      expect(seen!.vaporised, 'the renderer sees a vaporised death').toBe(true);
    });

    it(`${who}: a kill held for its drawn shell, released frames later`, () => {
      c.handleDamage(kill(id));
      c.handleDestroy(vaporise(id));
      c.applyShellEnd({ type: 'shell_end', e: [['g-1', 1010, 1050, 0, 0]] });
      for (let f = 0; f <= 16 && seen === null; f++) {
        c.placeShells(1004 + f * 0.5);
        renderFrame(id);
        if (id === HULL) c.handleSnapshot(snapshot(1012 + f, false));
        c.clockAnchorServerTick = 1012;
      }
      expect(seen, 'it died when the drawn shell got there').not.toBeNull();
      expect(seen!.vaporised, 'the renderer sees a vaporised death').toBe(true);
    });
  }

  it('an ordinary held death is not marked vaporised', () => {
    c.handleDamage(kill(HULL));
    c.handleDestroy({ type: 'destroy', targetId: HULL, shooterId: 'swarm-3' });
    renderFrame(HULL);
    c._shellTiming.onBeamFired(beam(HULL));
    renderFrame(HULL);
    expect(seen).not.toBeNull();
    expect(seen!.vaporised).toBe(false);
  });

  it('a vaporised death that is not held is marked on its destroy frame, as before', () => {
    c.handleDestroy(vaporise(AI));
    renderFrame(AI);
    expect(seen).toEqual({ exploding: true, vaporised: true });
  });
});
