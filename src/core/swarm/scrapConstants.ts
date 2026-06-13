/**
 * Scrap (scrap-on-death) physics + lifecycle constants.
 *
 * A scrap piece is one component of a destroyed composite ship that becomes a
 * free-floating, damageable, dynamic body. It rides the pose-core binary
 * channel as kind byte `SWARM_KIND_SCRAP = 3`. These constants tune how a
 * scrap body MOVES (subtle drift + spin + coast-then-slow) and how much
 * punishment it can take before it's destroyed, plus the global live-scrap cap
 * that keeps a mass-casualty event from flooding the swarm registry.
 *
 * Pure module. No imports, no side effects.
 */

/**
 * Linear damping applied to a scrap body. Small, so scrap COASTS after its
 * spawn burst then gradually slows to a near-stop rather than drifting forever
 * (asteroids/structures use 0 = ballistic; drones use their per-kind value).
 */
export const SCRAP_LINEAR_DAMPING = 0.15;

/**
 * Radial burst speed (game units / second) imparted to a scrap piece at spawn,
 * pushing it away from the dying ship's centroid. Subtle — scrap drifts apart
 * gently, it does not rocket off.
 */
export const SCRAP_BURST_SPEED = 30;

/**
 * Magnitude (rad/s) of the small random angular velocity given to a scrap piece
 * at spawn so it tumbles slowly as it drifts.
 */
export const SCRAP_SPIN = 0.6;

/**
 * Hull points seeded for a scrap body — presence is what makes scrap damageable
 * / destroyable through the existing swarm damage path (like a structure's
 * health pool). Modest, so scrap can be cleared by sustained fire.
 */
export const SCRAP_HP = 30;

/**
 * Default mass of a scrap body when a spawn spec omits an explicit mass. Light
 * — scrap is debris, easily nudged by anything that runs into it.
 */
export const SCRAP_DEFAULT_MASS = 1;

/**
 * Global cap on simultaneously-live scrap bodies. A single capital-ship death
 * can yield many components; this bounds the registry churn so a chain of
 * deaths can't exhaust SAB slots or the wire budget. The orchestrator (a later
 * sub-phase) enforces it.
 */
export const MAX_LIVE_SCRAP = 200;
