/**
 * Light/medium dogfighter kinds: SCOUT + FIGHTER.
 * Single-mount legacy chassis. See shipKinds/types.ts for the schemas.
 */

import {
  ShipKindSchema,
  LEGACY_FORWARD_MOUNT,
  LEGACY_PRIMARY_SLOT,
  type ShipKind,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Tuning derivation (top-down arcade — between space-feel and full-car).
//
// At a fixed 60 Hz step with `setLinearDamping(d)`, the steady-state speed
// from a constant per-tick impulse F applied to a body of mass m=1 is:
//
//   v_terminal = F / (1 - e^(-d/60))
//
// `d` is tuned from a "coast" target — how much velocity remains T seconds
// after release: `e^(-d * T)`.
//
//   d = 0.2 → 67% retained after 2 s (very floaty, near-space feel)
//   d = 0.3 → 55% retained                (Fighter)
//   d = 0.5 → 37% retained                (Scout, faster decel)
//   d = 0.6 → 30% retained
//   d = 1.0 → 14% retained                (full car-feel)
//
// Once `d` is fixed, F is solved from `v_terminal = F / (1 - e^(-d/60))` to
// land on the cruise speed. `maxSpeed` is the hard cap that boost can hit.
//
// Mass for ball colliders is normalised to ≈ 1 by the density formula in
// `World.spawnShip` (`density = 1 / (π * r²)`), so the formula above
// applies uniformly across kinds.
//
// `maxAngvel` is written directly each tick while a turn key is held;
// releasing both keys writes 0. Per-tap rotation is exactly
// `maxAngvel * tap_duration_seconds` — a 100 ms tap at `maxAngvel = 2.0`
// turns the ship 0.2 rad ≈ 11.5°. That's the resolution of fine aim.
// ─────────────────────────────────────────────────────────────────────────

export const SCOUT: ShipKind = ShipKindSchema.parse({
  id: 'scout',
  displayName: 'Scout',
  description: 'Light, fast, twitchy. Glass cannon.',
  // d=0.5 → 37% retained after 2 s (decisive decel without being grippy).
  // F=3.0, boost=2 → v_boosted = 3*2 / (1-e^(-0.5/60)) = 6 / 0.00831 ≈ 722 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 3.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 3.0,        // 172°/s — twitchy.
  maxSpeed: 750,
  linearDamping: 0.5,
  angularDamping: 0,     // unused — applyInput owns angvel every tick.
  lateralGrip: 0.05,     // half-life ≈ 230 ms — quickest to bite, still drifts.
  radius: 10,
  maxHealth: 90,
  // Glass cannon: shield equals hull, standard Halo regen.
  shieldMax: 90,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 90 / 120,
  // Bolt boat: small pool, ~10 s continuous fire (120 / (2 × 6 Hz)),
  // empty→full regen ~10 s. (plan §3.3)
  energyMax: 120,
  energyRegenRate: 0.2,
  // Phase-1 agility uplift (2026-05-10): drone terminal angvel
  // = maxTorque / ANGVEL_DAMPING (1.5). To match the player's
  // `maxAngvel = 3.0` we need `maxTorque ≈ 4.5`. `turnKp` bumped from
  // 5.0 → 8.0 so the P-controller actually asks for the new headroom
  // at modest bearing errors instead of saturating only when way off.
  // P3.11b — thrust raised ≈0.45× the player thrustImpulse (was 0.35) so a
  // pursuing drone closes the gap at ~0.7× player cruise instead of crawling
  // (the AI-impulse path bypasses maxSpeed; the standoff cap + brake still
  // settle it in weapons range).
  ai: { thrust: 1.35, turnKp: 8.0, maxTorque: 4.5 },
  shape: {
    kind: 'polygon',
    color: 0x00d4ff,
    scale: 1,
    // Slim dart, narrow waist.
    points: [
      [0, -14],
      [6, 8],
      [0, 4],
      [-6, 8],
    ],
  },
  // Bolts (weapons/energy/AI overhaul §2): scout fires the catalogue
  // `laser` (projectile bolt), not the legacy beam. Inline clone of the
  // shared forward mount with the weapon swapped — the frozen
  // LEGACY_FORWARD_MOUNT const stays `hitscan` for engineering kinds/tests.
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
});

export const FIGHTER: ShipKind = ShipKindSchema.parse({
  id: 'fighter',
  displayName: 'Fighter',
  description: 'Balanced all-rounder. The default.',
  // d=0.3 → 55% retained after 2 s (clear glide, still slows down).
  // F=2.0, boost=2 → v_boosted = 2*2 / (1-e^(-0.3/60)) = 4 / 0.00499 ≈ 802 u/s
  // 0.5× speed / +50% hull pass (2026-05-18): halved thrust + maxSpeed for
  // manageable pacing; hull/shield ×1.5 with regen rate ×1.5 (regen TIME held).
  thrustImpulse: 2.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.0,        // 115°/s — fine aim resolution at short taps.
  maxSpeed: 850,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.025,    // half-life ≈ 460 ms — clear drift on hard turns.
  radius: 12,
  maxHealth: 150,
  // Balanced: shield equals hull, standard Halo regen.
  shieldMax: 150,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 150 / 120,
  // Bolt boat: ~12.5 s continuous fire (150 / (2 × 6 Hz)). (plan §3.3)
  energyMax: 150,
  energyRegenRate: 0.25,
  // Phase-1 agility uplift (2026-05-10): match player `maxAngvel = 2.0`
  // — terminal angvel = maxTorque / 1.5, so maxTorque = 3.0.
  ai: { thrust: 0.9, turnKp: 6.0, maxTorque: 3.0 }, // P3.11b: ≈0.45× player thrust (was 0.25)
  shape: {
    kind: 'polygon',
    color: 0x00ff88,
    scale: 1,
    // The legacy `buildShipGfx` arrowhead, lifted verbatim for visual
    // continuity with pre-kind builds.
    points: [
      [0, -16],
      [-10, 10],
      [0, 5],
      [10, 10],
    ],
  },
  // Bolts (weapons/energy/AI overhaul §2) — see SCOUT note.
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
  // Dynamic weapon mounts (Phase 4 WS-B3) — two LATENT wing hardpoints,
  // inactive until an `activate_mount` upgrade turns one on (the player picks
  // the weapon). Geometry sits on the polygon wings (±10, 10); a ±30° forward
  // arc with a 4 rad/s slew mirrors the interceptor's wing turrets. `weaponId`
  // here is the catalogue DEFAULT — overridden by the player's choice on
  // activation. Latent ⇒ no aim/fire/render until activated.
  latentMounts: [
    {
      id: 'latent-wing-l',
      localX: -10,
      localY: 10,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'laser',
    },
    {
      id: 'latent-wing-r',
      localX: 10,
      localY: 10,
      baseAngle: 0,
      arcMin: -Math.PI / 6,
      arcMax: Math.PI / 6,
      rotationSpeed: 4,
      weaponId: 'laser',
    },
  ],
});
