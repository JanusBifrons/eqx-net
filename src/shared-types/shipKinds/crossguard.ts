/**
 * CROSSGUARD — the T-shape (2026-05-27). Wide bow crossbar atop a
 * long stem. Concave polygon (two reflex vertices where the stem
 * meets the underside of the crossbar). `poly-decomp.quickDecomp`
 * in `src/core/geometry/shipHullDecomp.ts` splits this into two
 * convex parts (crossbar + stem); `World.setHullExposed` then fan-
 * triangulates each part into `RAPIER.ColliderDesc.triangle` colliders
 * (triangle shapes are the ONLY 2D Rapier shape that fires
 * `CONTACT_FORCE_EVENTS` for static overlap — `cuboid`/`convexHull`
 * don't). Net result: the shield-down compound collider matches the
 * rendered silhouette exactly AND fires contact telemetry even for
 * two parked T-ships. See shipKinds/types.ts for the schemas.
 *
 * Tactical role: medium chassis, twin forward mounts at the tips of
 * the crossbar — wider firing baseline than the interceptor's wing
 * lasers, but slower to swing the nose around because the wide bow
 * carries rotational inertia. Pilot like a hammer, not a foil.
 */

import {
  ShipKindSchema,
  type ShipKind,
} from './types.js';

export const CROSSGUARD: ShipKind = ShipKindSchema.parse({
  id: 'crossguard',
  displayName: 'Crossguard',
  description: 'Massive engineering-test variant. 10× normal size, 30× mass. Built for impact testing — slow to manoeuvre, brutal to ram.',
  // Engineering-only — filter out of random galaxy spawn pool. Scale-10
  // chassis is intentionally too large for ambient gameplay (it leaked
  // into Sol Prime as a hunter bot in capture ilhqk6).
  engineeringOnly: true,
  // Tuning for a HUGE chassis: thrust scaled up so a player who picks
  // this kind can still accelerate at all (without scaling, mass-30
  // would mean accel ≈ thrust/30 → unmovable). 2.0 × 30 = 60 keeps the
  // arcade feel similar at this mass — though the radius-200 + scale-10
  // means it still cruises through a sector in seconds.
  thrustImpulse: 60.0,
  reverseFactor: 0.45,
  boostMultiplier: 2.0,
  // Sluggish yaw — a 200-radius disc at mass 30 has angular inertia
  // 0.5 * 30 * 200² = 600 000 (vs fighter's 0.5 * 1 * 12² = 72).
  // Player-driven angvel is written directly each tick so this cap
  // still bites; lowering it from 1.5 rad/s reflects the visual scale.
  maxAngvel: 0.4,
  maxSpeed: 800,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.02,
  // Huge collider — radius 213 matches the polygon's scaled bounding
  // circle exactly: max vertex distance from origin is
  // sqrt(140² + 160²) ≈ 212.6 (crossbar tips at (±140, -160) post-scale).
  // Was 200 prior to 2026-05-28 (tighter than the visible silhouette,
  // which made the shield ball collider sit INSIDE the rendered polygon —
  // the 2026-05-27 "I could go a little ways into the render area" smoke
  // bug). The visual ShieldAura ring derives from `kind.radius +
  // SHIELD_RADIUS_PAD`, so bumping to 213 sized BOTH the physical and
  // visual shield bubble to fully enclose the rendered hull (213 + 10 pad
  // = 223 ≥ 213 bounding circle). Mass + inertia formulas read
  // `kind.radius` too, so the angular inertia rises from
  // 0.5·30·200² = 600 000 to 0.5·30·213² = 680 535 (~13 % more sluggish
  // yaw — acceptable for a 10× chassis). Catalogue version bump (4→5)
  // signals the per-kind drift-clamp to refresh stored player health.
  radius: 213,
  // Heavy translational mass override (vs the default 1 every other
  // kind uses). 30× makes ramming impulses 30× weaker — the player
  // bounces off rather than punting the T-ship across the screen.
  mass: 30,
  // Tank hull/shield: scaled with the chassis so it survives a sustained
  // smoke-test ramming session. 1500 ≈ 10× heavy's 270 / 5× scout's 90.
  maxHealth: 1500,
  shieldMax: 1500,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 1500 / 120,
  // AI tuning kept conservative — Crossguard is spawned in `shield-test`
  // under `peacefulDrones: true` (the AI is `PassiveDroneBehaviour`,
  // which ignores the tuning entirely). The numbers below are only
  // touched if a future room uses Crossguard as a hostile drone.
  ai: { thrust: 5.0, turnKp: 4.0, maxTorque: 12.0 },
  shape: {
    kind: 'polygon',
    color: 0xffcc33,
    // Scale × 10 — the catalogue's `shape.scale` multiplies the polygon
    // points at draw time (and in `shipShapeToPolygon` → triangulator,
    // so collision geometry matches the rendered silhouette). The mount
    // positions below are baked at the SCALED coordinate frame because
    // `mountWorldOrigin` reads `mount.localX/Y` raw (it doesn't apply
    // `shape.scale`) — so mount positions and polygon vertices must be
    // authored in the SAME coordinate system. For a 10× polygon, mounts
    // at the visual crossbar tips are at (±120, -120) not (±12, -12).
    scale: 10,
    // Pixi-up authored (Y goes DOWN on screen; nose at negative Y).
    // The polygon is wound CW in standard math orientation; the
    // triangulator normalises to CCW so `rayHitsConvexPolygon`'s
    // outward-normal formula works either way.
    //
    //  (-14,-16) ─────────── (14,-16)     ← crossbar top
    //      │                     │
    //  (-14,-10)               (14,-10)   ← outer crossbar bottom
    //          \               /
    //          (-4,-8) ─── (4,-8)         ← inner crossbar bottom (reflex)
    //             │           │           ← stem sides
    //             │   stem    │
    //          (-4, 12) ─ (4, 12)         ← stem tail
    //
    // Outer crossbar bottom y=-10, inner y=-8: the slight slope is
    // load-bearing. With all four points on the same y-line (the
    // first draft put them at y=-8), the ear-clipping triangulator
    // produced a degenerate 4-collinear-vertex polygon after clipping
    // the stem, returning 4 triangles for an n=8 polygon (test expects
    // n-2 = 6). The 2 u y-offset breaks collinearity so the
    // post-stem polygon is a trapezoid the triangulator can split
    // cleanly. Two reflex vertices at (-4,-8) and (4,-8) — the only
    // concavity.
    points: [
      [-14, -16],
      [14, -16],
      [14, -10],
      [4, -8],
      [4, 12],
      [-4, 12],
      [-4, -8],
      [-14, -10],
    ],
  },
  mounts: [
    // Twin crossbar-tip mounts at the SCALED visual positions.
    // **`mount.localY` is in MATH-UP convention** (Y > 0 = forward of
    // body center = top of sprite after the renderer's
    // `turret.y = -mount.localY` flip in `MountVisualManager.ts`). So
    // for the visual crossbar tips (at the TOP of the sprite, where the
    // polygon's Y < 0 in Pixi-up authoring) the mount's localY is
    // POSITIVE. Polygon scale is 10, crossbar tips at scaled vertex
    // (±140, ±160) — mounts at (±120, +120) sit just inside the tips,
    // on the underside. Pre-2026-05-28 these were authored as
    // (±120, -120) under the (wrong) belief that mount and polygon
    // shared the same Y convention — they don't (polygon is Pixi-up
    // authored, mount is math-up). Net visual position was at the STEM
    // TAIL, not the crossbar — the smoke "way off" report.
    // Narrow ±22.5° arc — the player aims with the body, not the turret.
    {
      id: 'cross-l',
      localX: -120,
      localY: 120,
      baseAngle: 0,
      arcMin: -Math.PI / 8,
      arcMax: Math.PI / 8,
      rotationSpeed: 2.5,
      weaponId: 'hitscan',
    },
    {
      id: 'cross-r',
      localX: 120,
      localY: 120,
      baseAngle: 0,
      arcMin: -Math.PI / 8,
      arcMax: Math.PI / 8,
      rotationSpeed: 2.5,
      weaponId: 'hitscan',
    },
  ],
  slots: [
    { id: 'primary', displayName: 'Primary', mountIds: ['cross-l', 'cross-r'] },
  ],
});
