/**
 * L-SHAPE — engineering-room concave-hull stress test (2026-05-28). Two
 * rectangles joined at a right angle: a vertical arm at the top-left and
 * a horizontal arm extending right at the bottom. Designed to expose
 * physics bugs that only manifest with a deeply-concave "armpit"
 * geometry — flying into the inner corner at full speed is the worst
 * case for resolver penetration vs visual rendering.
 *
 * Low mass (5) so the player can move it under thrust (visible physics
 * response), but not so low that it scatters on first contact. Gigantic
 * — `scale: 10` puts the bounding box at 1600 × 2000 world units, so
 * any pixel-scale visual / collider mismatch is unmissable.
 *
 * Spawned by the `ramming-probe-test` room (`src/server/index.ts`); the
 * `tests/e2e/ramming-probe-armpit.spec.ts` test drives the local player
 * full-thrust into the armpit and harvests `ramming_probe` diag entries.
 */

import {
  ShipKindSchema,
  type ShipKind,
} from './types.js';

export const L_SHAPE: ShipKind = ShipKindSchema.parse({
  id: 'el',
  displayName: 'L-Frame',
  description: 'Engineering chassis. L-shaped silhouette, gigantic, low-mass — the deliberate worst case for resolver vs render alignment.',
  // Engineering-only — filter out of random galaxy spawn pool. Scale-10
  // chassis (~2000 u square per the 2026-05-28 bisect) is intentionally
  // unplayable for ambient drones; capture ilhqk6 caught it leaking into
  // Sol Prime as a hunter bot, which is also where the user reported
  // the "square ship bigger than its shield" smoke bug.
  engineeringOnly: true,
  // Sluggish but movable. Mass 5 keeps the L a low-friction punching bag
  // for the probe test; thrust 8 is enough to spin a player around the
  // armpit if it's spawned as a player kind.
  thrustImpulse: 8.0,
  reverseFactor: 0.45,
  boostMultiplier: 1.5,
  maxAngvel: 0.5,
  maxSpeed: 500,
  linearDamping: 0.3,
  // Angular damping 0.8 so the L doesn't keep spinning forever once
  // a slightly-off-axis hit imparts torque. (Symmetric L + on-axis
  // approach should give zero torque, but tiny x drifts in player
  // input accumulate over many ticks; damping eats them.)
  angularDamping: 0.8,
  lateralGrip: 0.02,
  // Bounding circle of the post-scale polygon: vertices reach
  // (160, +100) at the horizontal arm's outer corner — distance from
  // origin (0, 0) ≈ sqrt(160² + 100²) ≈ 189. The polygon is NOT centred
  // on the origin in catalogue space (it spans x ∈ [0, 160], y ∈
  // [-100, 100] in Pixi-up), so the "bounding circle from origin" is a
  // crude over-estimate; for the shield bubble we use a slightly tight
  // value and accept the asymmetric overhang on the horizontal arm.
  radius: 190,
  // 2026-05-28 BISECT — mass 5000. With player mass 1, ratio 1:5000
  // means each contact impulse moves the rectangle only ~0.02 % of
  // what the player moves, so the player CANNOT shove it away on
  // first impact — they end up pressed against it for as long as
  // they hold thrust. This is the "sustained pushing" regime the
  // user actually cares about (one impact and bounce was the wrong
  // test scenario).
  mass: 5000,
  maxHealth: 600,
  // Effectively zero shield: max 1 ("nominally has shields" so the kind
  // passes structural validation) but they regen so slowly (delay
  // ~16 minutes at 60 Hz) that they NEVER come back up during a probe
  // session. This pins the L into hull-exposed state for the entirety
  // of `tests/e2e/ramming-probe-armpit.spec.ts` — without it, the
  // shield ball collider (radius 190 + pad) is much smaller than the
  // polygon (extent ~2000) and the player tunnels right past the L's
  // body without any polygon-vs-ball collision firing. Engineering
  // kind only; not for live gameplay.
  shieldMax: 1,
  shieldRegenDelayTicks: 60_000,
  shieldRegenRate: 0.01,
  // Engineering-only fixture — generous energy so explicit spawns aren't
  // fire-locked; never tuned for live play.
  energyMax: 1000,
  energyRegenRate: 5,
  ai: { thrust: 3.0, turnKp: 3.0, maxTorque: 8.0 },
  shape: {
    kind: 'polygon',
    color: 0xff8844,
    scale: 10,
    // 2026-05-28 BISECT — simple convex rectangle (no decomposition,
    // no concave seam). User suggestion: see if the visual overlap
    // reproduces on a normal object. 200 × 200 in catalogue space ×
    // scale 10 = 2000 × 2000 in body-local space. Single convex part;
    // poly-decomp returns it as-is. If the player ship still ends up
    // inside the orange silhouette, the bug is not decomposition-
    // related and we look elsewhere (Y-flip, render-vs-collider
    // alignment, or the resolver path itself).
    points: [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ],
  },
  // Single forward mount at the origin — the L-shape is a test chassis,
  // not a combat platform.
  mounts: [
    {
      id: 'forward',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: 0,
      arcMax: 0,
      rotationSpeed: 0,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['forward'] },
  ],
});
