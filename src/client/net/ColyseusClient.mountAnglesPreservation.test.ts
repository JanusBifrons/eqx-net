/**
 * Phase 3a-2 — mount-angle preservation lock
 * (plan: e2e-rebuild, master plan i-want-you-to-lively-tulip.md)
 *
 * Per-surface deterministic lock for the bug class documented in
 * `src/client/CLAUDE.md` → "Multi-mount mirror surfaces (Phase 2c–4c,
 * 2026-05-11)":
 *
 *   "Per-frame `mirror.ships.set()` rebuild MUST preserve `mountAngles`.
 *    The local-ship update in `ColyseusClient.updateMirror()` and the
 *    remote-ship update in `syncMirror()` both reconstruct each ship's
 *    mirror entry from scratch (predWorld pose + lerp offset).
 *    Non-spatial fields need explicit `...(prev?.X ? { X: prev.X } : {})`
 *    preservation or they wipe at 60 Hz."
 *
 * The visible bug when this rule was broken: the local player's
 * interceptor showed two correctly-rotated wing beams via the one-shot
 * ghost projectile path (which carries pre-computed endpoints) but the
 * continuous `liveBeam` rendered straight forward — because the renderer
 * re-derives beam direction from `mirror.ships.get(localId).mountAngles`
 * each frame, and that field was being wiped between
 * `tickLocalMountAim`'s write and the renderer's read.
 *
 * Per CLAUDE.md Invariant #12: WeaponMountController.tickSlot is the
 * ONLY path that may write per-mount rotation angles. tickLocalMountAim
 * is its caller for the local player; updateMirror's per-frame rebuild
 * must keep that write intact.
 *
 * Why this test layer (Invariant #13 — "test where the bug LIVES"):
 *   - The bug surfaces in the RENDERER's beam direction, but its CAUSE
 *     is at the mirror-rebuild seam in ColyseusClient.
 *   - WeaponMountController.test.ts (14 cases) locks pick/rotate logic
 *     in isolation. weapon-switching.spec.ts (E2E smoke) locks mode
 *     switching.
 *   - What's missing — locked here: that the per-frame rebuild does
 *     NOT clobber a previously-written mountAngles array. The bug
 *     would re-emerge with one accidental edit deleting the spread.
 *   - E2E coverage would require: a URL flag for player ship kind
 *     (currently absent), drones provoked into hostility, sustained
 *     fire keeping the mount auto-aiming, plus a `data-mount-angles`
 *     attribute (currently absent). All that surface area to lock a
 *     single-line regression in ColyseusClient. The integration seam
 *     is the right level — same pattern as
 *     `ColyseusClient.lingeringJitter.test.ts` for lingering hull
 *     pose preservation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';

interface Internals {
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  reconciler:
    | {
        lerpOffset: { x: number; y: number };
        lerpAngleOffset: number;
        advanceLerp(ms: number): void;
      }
    | null;
  mirror: {
    ships: Map<
      string,
      {
        x: number;
        y: number;
        vx: number;
        vy: number;
        angle: number;
        kind?: string;
        displayName?: string;
        mountAngles?: number[];
      }
    >;
    localPlayerId: string | null;
  };
  lastFrameMs: number;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function mockReconciler(): {
  lerpOffset: { x: number; y: number };
  lerpAngleOffset: number;
  advanceLerp(ms: number): void;
} {
  return {
    lerpOffset: { x: 0, y: 0 },
    lerpAngleOffset: 0,
    advanceLerp(_ms: number) {
      /* no-op for this test — lerp settling is out of scope */
    },
  };
}

describe('mount-angle preservation: per-frame mirror rebuild keeps tickLocalMountAim writes alive', () => {
  let client: ColyseusGameClient;
  let internals: Internals;
  const LOCAL_ID = 'player-1';

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    internals.predWorld.spawnShip(LOCAL_ID, 100, 200, 'interceptor');
    internals.reconciler = mockReconciler();
    internals.mirror.localPlayerId = LOCAL_ID;
    internals.lastFrameMs = 1000 / 60;
  });

  it('preserves a written mountAngles array across the local-player rebuild', () => {
    // Simulate tickLocalMountAim having written the rotated angles
    // for an interceptor's two wing mounts. Values are arbitrary but
    // non-zero/non-default so a "fell back to baseAngle" regression
    // is observable.
    const ANGLES = [0.523, -0.279]; // ~30° and ~−16°
    internals.mirror.ships.set(LOCAL_ID, {
      x: 100, y: 200, vx: 0, vy: 0, angle: 0,
      kind: 'interceptor',
      mountAngles: ANGLES,
    });

    // This is the per-frame call from the App.tsx rAF loop. It rebuilds
    // the mirror entry from predWorld + lerp offset. The bug class:
    // if the rebuild drops the `mountAngles` spread, the renderer's
    // next read sees `undefined` and falls back to baseAngle (zero).
    internals.updateMirror();

    const after = internals.mirror.ships.get(LOCAL_ID);
    expect(after, 'local-player entry must survive updateMirror').toBeDefined();
    expect(
      after!.mountAngles,
      [
        'mountAngles wiped by per-frame mirror rebuild. The renderer',
        're-derives beam geometry from this field each frame; wiping it',
        'flips visible beams back to baseAngle. Restore the explicit',
        '`...(prev?.mountAngles ? { mountAngles: prev.mountAngles } : {})`',
        'spread in ColyseusClient.updateMirror() (local-player branch).',
      ].join('\n'),
    ).toEqual(ANGLES);
  });

  it('leaves mountAngles undefined when no prior write exists (default fallback)', () => {
    // No tickLocalMountAim write yet — pre-fire baseline. The legacy
    // single-mount fighter/scout/heavy ships never populate this field
    // and the renderer correctly falls back to baseAngle. Locking this
    // ensures the preservation logic doesn't accidentally synthesise
    // an empty array (which would still be "defined" and could fail
    // truthiness checks downstream).
    internals.mirror.ships.set(LOCAL_ID, {
      x: 100, y: 200, vx: 0, vy: 0, angle: 0,
      kind: 'fighter',
    });

    internals.updateMirror();

    const after = internals.mirror.ships.get(LOCAL_ID);
    expect(after).toBeDefined();
    expect(after!.mountAngles).toBeUndefined();
  });

  it('preserves mountAngles across MULTIPLE successive rebuilds (60 Hz steady state)', () => {
    // The renderer reads mirror.ships.get(localId).mountAngles every
    // frame at 60 Hz. The rebuild also fires every frame from the rAF
    // loop. A regression where preservation works ONCE but not across
    // repeated rebuilds (e.g. an accidental `prev` shadowing or
    // reassignment) is the bug class this case catches.
    const ANGLES = [0.4, -0.1];
    internals.mirror.ships.set(LOCAL_ID, {
      x: 100, y: 200, vx: 0, vy: 0, angle: 0,
      kind: 'interceptor',
      mountAngles: ANGLES,
    });

    for (let frame = 0; frame < 10; frame++) {
      internals.updateMirror();
      const entry = internals.mirror.ships.get(LOCAL_ID);
      expect(
        entry?.mountAngles,
        `mountAngles wiped at frame ${frame} (preserved at frame 0 ` +
          'but not in steady state — the rebuild path\'s `prev` lookup ' +
          'is being short-circuited after the first iteration).',
      ).toEqual(ANGLES);
    }
  });

  it('preserves `kind` and `displayName` alongside mountAngles (parity with the documented pattern)', () => {
    // CLAUDE.md lists three non-spatial fields requiring preservation
    // in this rebuild block: `kind`, `displayName`, `mountAngles`.
    // Lock all three together — a regression that drops one is the
    // same class as dropping mountAngles. Catching the broader set
    // here makes the contract explicit without separate tests per
    // field.
    internals.mirror.ships.set(LOCAL_ID, {
      x: 100, y: 200, vx: 0, vy: 0, angle: 0,
      kind: 'gunship',
      displayName: 'Test Player',
      mountAngles: [0.1, -0.2, 0.3, -0.4], // gunship has 4 mounts
    });

    internals.updateMirror();

    const after = internals.mirror.ships.get(LOCAL_ID)!;
    expect(after.kind, 'kind must survive per-frame rebuild').toBe('gunship');
    expect(after.displayName, 'displayName must survive per-frame rebuild').toBe('Test Player');
    expect(after.mountAngles, 'mountAngles must survive per-frame rebuild')
      .toEqual([0.1, -0.2, 0.3, -0.4]);
  });
});
