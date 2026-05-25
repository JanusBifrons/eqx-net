/**
 * Heavy-class kinds: HEAVY (single-mount tank) + INTERCEPTOR (twin wing
 * lasers, multi-mount Phase 3) + GUNSHIP (fore-and-aft multi-mount).
 * Grouped here because they all carry more hull than the dogfighter pair.
 * See shipKinds/types.ts for the schemas.
 */

import {
  ShipKindSchema,
  LEGACY_FORWARD_MOUNT,
  LEGACY_PRIMARY_SLOT,
  type ShipKind,
} from './types.js';

export const HEAVY: ShipKind = ShipKindSchema.parse({
  id: 'heavy',
  displayName: 'Heavy',
  description: 'Sluggish accel, brutal top speed, a lot of hull.',
  // d=0.2 → 67% retained after 2 s (heavy momentum, long glide).
  // F=1.5, boost=2 → v_boosted = 1.5*2 / (1-e^(-0.2/60)) = 3 / 0.00333 ≈ 901 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 1.5,
  reverseFactor: 0.4,
  boostMultiplier: 2.0,
  maxAngvel: 1.4,        // 80°/s — sluggish wheel.
  maxSpeed: 950,
  linearDamping: 0.2,
  angularDamping: 0,
  lateralGrip: 0.012,    // half-life ≈ 960 ms — slides like a tank around corners.
  radius: 16,
  maxHealth: 270,
  // Tank: deepest shield mirrors deepest hull, standard Halo regen.
  shieldMax: 270,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 270 / 120,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 1.4`.
  ai: { thrust: 0.175, turnKp: 4.0, maxTorque: 2.1 },
  shape: {
    kind: 'polygon',
    color: 0xff7733,
    scale: 1,
    // Stubby pentagon — wide shoulders, blunt nose.
    points: [
      [0, -14],
      [12, -2],
      [10, 14],
      [-10, 14],
      [-12, -2],
    ],
  },
  mounts: [LEGACY_FORWARD_MOUNT],
  slots: [LEGACY_PRIMARY_SLOT],
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-mount kinds (Phase 3, 2026-05-11). These are the first ship-kinds
// that exercise the mount/slot plumbing introduced in Phases 1–2c.
//
// `interceptor` — twin wing-mounted lasers. Faster than a fighter, less hull
// than a scout, but fires two beams per cooldown so it has a higher DPS
// ceiling. The wing mounts sit at (±8, 2), which puts them at the rear of
// the wings on the polygon below. Both mounts are in one `primary` slot, so
// pressing fire emits two beams in one frame.
//
// `gunship` — fore-and-aft hitscan platform. Sluggish hull with a brutal
// rear arc: the rear mount has `baseAngle = π`, so it fires backward
// regardless of which way the ship is moving. Pilots can run from a pursuer
// while still landing hits. Both mounts share the `primary` slot so the fire
// trigger fans out to both — the player decides which to USE by orienting
// the ship.
//
// Phase 3 ships static mounts (`arcMin === arcMax === 0`, `rotationSpeed === 0`).
// Phase 4b adds rotation via WeaponMountController + MountAngleRing.
// ─────────────────────────────────────────────────────────────────────────

export const INTERCEPTOR: ShipKind = ShipKindSchema.parse({
  id: 'interceptor',
  displayName: 'Interceptor',
  description: 'Twin-cannon light. Two forward beams per cooldown — high DPS, low hull.',
  // d=0.4 → 45% retained after 2 s (between fighter 0.3 and scout 0.5).
  // F=2.5, boost=2 → v_boosted = 2.5*2 / (1-e^(-0.4/60)) = 5 / 0.00664 ≈ 753 u/s.
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 2.5,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.5,        // 143°/s — quicker than fighter, less twitchy than scout.
  maxSpeed: 800,
  linearDamping: 0.4,
  angularDamping: 0,
  lateralGrip: 0.04,     // half-life ≈ 280 ms — clear drift but bites.
  radius: 11,
  maxHealth: 120,
  // Twin-cannon light: shield equals hull, standard Halo regen.
  shieldMax: 120,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 120 / 120,
  // AI tuning sized to the new maxAngvel: maxTorque = maxAngvel * 1.5 = 3.75.
  ai: { thrust: 0.3, turnKp: 7.0, maxTorque: 3.75 },
  shape: {
    kind: 'polygon',
    color: 0xb066ff,
    scale: 1,
    // Long nose, broad swept wings, narrow tail.
    points: [
      [0, -15],
      [-4, -3],
      [-12, 8],
      [-3, 10],
      [3, 10],
      [12, 8],
      [4, -3],
    ],
  },
  mounts: [
    // Wing mounts: ±30° forward arc, 4 rad/s slew. Phase 4b.1 (2026-05-11)
    // — arc and rotation declared in the catalogue; client-side tracking
    // animation lands in 4b.2, server-authoritative compute in 4b.3.
    {
      id: 'wing-l',
      localX: -8,
      localY: 2,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'hitscan',
    },
    {
      id: 'wing-r',
      localX: 8,
      localY: 2,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['wing-l', 'wing-r'] },
  ],
});

export const GUNSHIP: ShipKind = ShipKindSchema.parse({
  id: 'gunship',
  displayName: 'Gunship',
  description: 'Fore-and-aft platform. Forward laser plus a backward rear gun — fire while you flee.',
  // d=0.25 → 60% retained after 2 s (between fighter 0.3 and heavy 0.2).
  // F=1.75, boost=2 → v_boosted = 1.75*2 / (1-e^(-0.25/60)) = 3.5 / 0.00415 ≈ 842 u/s.
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 1.75,
  reverseFactor: 0.4,
  boostMultiplier: 2.0,
  maxAngvel: 1.6,        // 92°/s — between fighter 2.0 and heavy 1.4.
  maxSpeed: 750,
  linearDamping: 0.25,
  angularDamping: 0,
  lateralGrip: 0.018,    // half-life ≈ 640 ms — slidy.
  radius: 14,
  maxHealth: 210,
  // Fore-and-aft platform: shield equals hull, standard Halo regen.
  shieldMax: 210,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 210 / 120,
  ai: { thrust: 0.2, turnKp: 5.0, maxTorque: 2.4 },
  shape: {
    kind: 'polygon',
    color: 0xff7722,
    scale: 1,
    // Elongated brick — long fuselage, modest wings.
    points: [
      [-3, -16],
      [3, -16],
      [10, -4],
      [10, 12],
      [-10, 12],
      [-10, -4],
    ],
  },
  mounts: [
    // Forward mount: ±45° arc, 3 rad/s slew. Slower than the interceptor's
    // dedicated wings because the gunship is the heavy chassis.
    {
      id: 'forward',
      localX: 0,
      localY: -12,        // pivot near the nose
      baseAngle: 0,       // fires forward (−y)
      arcMin: -Math.PI / 4,
      arcMax: Math.PI / 4,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
    // Rear mount: ±90° arc, 3 rad/s. Wider sweep so the rear turret can
    // cover the gunship's blind sides while the body keeps moving forward.
    {
      id: 'rear',
      localX: 0,
      localY: 10,         // pivot near the tail
      baseAngle: Math.PI, // fires backward (+y)
      arcMin: -Math.PI / 2,
      arcMax: Math.PI / 2,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['forward', 'rear'] },
  ],
});
