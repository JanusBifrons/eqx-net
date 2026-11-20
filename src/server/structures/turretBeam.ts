// Split out of StructureGridSubsystem.ts (god-file cap); re-exported there.

/**
 * Resolve a laser turret's CONTINUOUS-beam firing params (playtest 2026-06-10
 * Issue 5 — "defence structures fire in pulses instead of constantly, like the
 * player does"). All laser beam weapons now work the same everywhere: the
 * turret fires its bound catalogue beam weapon (`mount.weaponId`) on that
 * weapon's standard cooldown — a steady stream of small hits the client renders
 * as one continuous beam (its laser TTL > the beam cadence) — instead of one
 * big lump every `fireRateMs`. Per-hit damage is rebalanced to preserve the
 * kind's tuned DPS (`weaponDamage / fireRateMs`) across the faster cadence, so
 * total damage ≈ today's. `fireRateMs`/`weaponDamage` are retired as a PULSE
 * gate and repurposed as the DPS budget.
 *
 * Pure + scalar in/out — unit-locked independent of the room.
 */
export function resolveTurretBeam(
  weaponDamage: number,
  fireRateMs: number,
  beamCooldownTicks: number,
): { cooldownMs: number; perHitDamage: number } {
  const cooldownMs = (beamCooldownTicks / 60) * 1000;
  const dps = fireRateMs > 0 ? weaponDamage / (fireRateMs / 1000) : 0;
  return { cooldownMs, perHitDamage: dps * (cooldownMs / 1000) };
}
