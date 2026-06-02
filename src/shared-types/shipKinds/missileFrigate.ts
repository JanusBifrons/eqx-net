/**
 * Missile Frigate — a battleship-feel class. ~2× the radius of fighters,
 * sluggish turn rate, deep hull, and forward heat-seeker racks instead of
 * direct-fire beams. The first kind in the catalogue with the new
 * `heat-seeker` mount weapon (see src/core/combat/WeaponCatalogue.ts).
 *
 * Tuning intent: deliberately slow so the missile cadence feels like
 * artillery, not dogfighting. Players see this class and read "big, slow,
 * dangerous at range" before reading the silhouette.
 *
 * See docs/architecture/missile-simulation.md for the missile lifecycle
 * and docs/features/missiles.md for the player-facing description.
 */

import {
  ShipKindSchema,
  type ShipKind,
} from './types.js';

export const MISSILE_FRIGATE: ShipKind = ShipKindSchema.parse({
  id: 'missile-frigate',
  displayName: 'Missile Frigate',
  description: 'Slow battleship-class hull. Twin forward heat-seeker racks — devastating at range, vulnerable up close.',
  // d=0.15 → 74% retained after 2 s (heaviest momentum yet; long glide).
  // F=1.0, boost=1.8 → v_boosted = 1.0*1.8 / (1-e^(-0.15/60)) = 1.8 / 0.0025 ≈ 720 u/s
  thrustImpulse: 1.0,
  reverseFactor: 0.3,
  boostMultiplier: 1.8,
  maxAngvel: 0.8,        // ≈46°/s — visibly sluggish; HEAVY is 1.4 rad/s.
  maxSpeed: 600,         // Lowest in the catalogue.
  linearDamping: 0.15,
  angularDamping: 0,
  lateralGrip: 0.01,     // half-life ≈ 1.15 s — slides like a freighter.
  radius: 24,            // ~2× FIGHTER (12) / INTERCEPTOR (11).
  maxHealth: 500,        // Substantially tankier than HEAVY (270).
  shieldMax: 400,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 400 / 120,
  // Missile pool (plan §3.4): energyMax 240 ≈ a 4-salvo opening burst
  // (slot cost 60), then steady regen (0.67/tick × 90-tick cooldown ≈ one
  // slot cost per cooldown window) paces throughput to ~8 missiles in
  // flight over the 6 s TTL. Boost shares this pool — boosting the frigate
  // temporarily starves missile output (the intended tradeoff).
  energyMax: 240,
  energyRegenRate: 0.67,
  ai: { thrust: 0.12, turnKp: 3.0, maxTorque: 1.2 },
  shape: {
    kind: 'polygon',
    color: 0x66bbff,
    scale: 1,
    // Big elongated hull — flat bow, broad shoulders, tapered stern.
    // Reads visibly larger than every other kind.
    points: [
      [0, -22],
      [10, -16],
      [16, -2],
      [16, 16],
      [8, 22],
      [-8, 22],
      [-16, 16],
      [-16, -2],
      [-10, -16],
    ],
  },
  mounts: [
    // Twin forward racks. Narrow ±15° arc so the racks visibly track but
    // can't pivot dramatically — frigate must orient toward target. Slow
    // rotation (1.5 rad/s) matches the sluggish chassis feel.
    //
    // localY = +12 (NOT -8 as in the first cut). The catalogue's
    // `localX`/`localY` convention is GAME-SPACE (where +y is forward
    // — `mountWorldOrigin` in src/server/rooms/mountGeometry.ts does a
    // straight rotation without any Y-flip). `MountVisualManager` flips
    // Y to render in Pixi-up sprite space. The original -8 put the
    // racks 8 units BEHIND the ship's centre in game-space, so missile
    // spawn (mount + 20u barrel-forward) landed inside the hull
    // silhouette behind the bow — the "missiles appear to launch from
    // behind my ship" smoke-test class. +12 places the racks just
    // forward of centre, inside the hull's wider shoulders (shape
    // points span y=-22..+22 in sprite-Pixi-up = +22..-22 in game-y),
    // so the 20u barrel offset puts the missile out past the bow tip.
    {
      id: 'rack-l',
      localX: -10,
      localY: 12,
      baseAngle: 0,
      arcMin: -Math.PI / 12,
      arcMax: Math.PI / 12,
      rotationSpeed: 1.5,
      weaponId: 'heat-seeker',
    },
    {
      id: 'rack-r',
      localX: 10,
      localY: 12,
      baseAngle: 0,
      arcMin: -Math.PI / 12,
      arcMax: Math.PI / 12,
      rotationSpeed: 1.5,
      weaponId: 'heat-seeker',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['rack-l', 'rack-r'] },
  ],
});
