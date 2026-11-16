import { combatDistanceScale } from '../../shared-types/shipScale/tuning.js';
import { projectileEngageReach } from '../../shared-types/combat/navalGuns.js';
import { CAPITAL_TURRET_DEFS } from './capitalTurretDefs.js';
import { TRACTOR_DEF, type TractorSpec } from './tractorSpec.js';
export type WeaponMode = 'hitscan' | 'projectile' | 'missile';
export type WeaponId = 'hitscan' | 'laser' | 'heat-seeker' | 'pulse-orb' | 'charge-laser' | 'autocannon'
  | 'naval_s' | 'naval_m' | 'naval_l' | 'naval_xl'
  // Coastal defences (plan coastal-defences): land guns bigger than any ship's.
  | 'naval_xxl' | 'naval_siege'
  // Capital railgun (plan beam-slices §7): a charged, very fast shell.
  | 'railgun'
  // Capital heavy beam (plan beam-slices §8): a sustained burn that slices.
  | 'heavy_beam'
  // Mining laser (plan partitioned-chasing-lark PR 7): a salvage beam.
  | 'mining_laser' | 'tractor'; // tractor: salvage PR 11, a force, no damage

interface WeaponDefBase {
  id: WeaponId;
  displayName: string;
  mode: WeaponMode;
  damage: number;
  cooldownTicks: number;
  /** Energy drained from the firing ship's pool per SLOT trigger (NOT per
   *  mount). A slot's effective cost is the MAX of its mounts' `energyCost`
   *  (homogeneous slots collapse to a single value; the interceptor's twin
   *  beams cost one beam-slot's energy, not 2×). Drones are NOT energy-gated
   *  — this field is read only on the player fire path. See
   *  `src/core/combat/Energy.ts` and `docs/plans/weapons-energy-ai-overhaul.md`
   *  §3. */
  energyCost: number;
  /** Charge-up (any weapon mode): the shot fires `chargeTicks` after the
   *  trigger instead of at once. The per-mount charge state lives in ONE
   *  store (`WeaponMountTicker.droneMountChargeStart`), shared by the AI salvo
   *  path and capital turrets; it rides the snapshot as `drones[].chargingMask`
   *  + `chargeStartTick`. AI pilots only. Absent ⇒ instant. */
  chargeTicks?: number;
  /** What a completed charge does. 'locked-direction' (default): fire at once
   *  down the barrel, so a target that moved during the wind-up is missed
   *  (the robot charge laser). 'when-bearing': fire only when the mount bears
   *  on its target; otherwise hold the charge and fire the moment it bears. */
  chargeRelease?: 'locked-direction' | 'when-bearing';
  /** How the client telegraphs the charge. 'ring-line' (default): a hot ring
   *  round the hull and a faint line out to the range. 'mount-glow': a glow on
   *  the charging gun only, ramping up over the charge, no aim line. */
  chargeTelegraph?: 'ring-line' | 'mount-glow';
  /** How a kill by this weapon breaks the hull (docs/architecture/
   *  capital-destruction.md "Kill cuts"): `slice` cuts it dead straight along
   *  the shot's line through the kill point; `channel` erases a straight strip
   *  `width` world units wide along that line. Absent ⇒ the normal break-up. */
  killCut?: WeaponKillCut;
  /** Follow-through after a kill (capital turrets): when a shot from a mount
   *  KILLS what it hit, that mount holds its angle and keeps firing at its own
   *  cadence down the same line for this many game ticks (60 = 1 s at 1×), so
   *  the beam burns on through the cut; then it resumes normal targeting
   *  (`WeaponMountTicker.tickCapitalMounts`). Absent ⇒ none: the mount looks
   *  for its next target at once. */
  followThroughTicks?: number;
  /** Per-target damage multipliers, read only via `weaponTargetFactor` (weapon-mounts.md "Per-target damage factors"). */
  targetFactor?: WeaponTargetFactor;
  tractor?: TractorSpec; // a TRACTOR beam: no ray, no damage; fire renews a lease (tractorSpec.ts)
}

/** What a hit lands on, for `weaponTargetFactor`: a raised shield, an exposed
 *  (or shieldless) ship hull, a structure, a capital wreck piece, or an
 *  asteroid ('rock': scales the ore a hit draws, server `OreDraw`). */
export type WeaponTargetClass = 'shield' | 'hull' | 'structure' | 'wreck' | 'rock';

/** `WeaponDefBase.targetFactor`: a damage multiplier per target class. */
export type WeaponTargetFactor = { readonly [K in WeaponTargetClass]?: number };

/** 'wreck' factor of a weapon naming none: ordinary guns wear wreck integrity
 *  10× slower than the mining laser (1; capital-destruction.md §S4). */
export const WRECK_DEFAULT_TARGET_FACTOR = 0.1;

/** The damage multiplier `def` applies against `cls`. Pure, allocation-free.
 *  Every class defaults to 1 except wreck (`WRECK_DEFAULT_TARGET_FACTOR`:
 *  wreck pieces take no damage, the factor scales only their integrity wear)
 *  and rock (0: only a weapon that names a rock factor, the mining laser,
 *  mines ore). */
export function weaponTargetFactor(def: WeaponDef, cls: WeaponTargetClass): number {
  return def.targetFactor?.[cls] ?? (cls === 'wreck' ? WRECK_DEFAULT_TARGET_FACTOR : cls === 'rock' ? 0 : 1);
}

/** Resolve `def`'s factors for one hit into the per-layer multiplier the
 *  shield/hull router takes (`out`, reused scratch, #14): a structure takes its
 *  'structure' factor on every layer, anything else 'shield' on a raised
 *  shield and 'hull' below it. Returns `undefined` when the weapon has no
 *  factors, so a factor-less hit stays byte-identical. */
export function weaponLayerMul(
  def: WeaponDef, isStructure: boolean, out: { shield: number; hull: number },
): { shield: number; hull: number } | undefined {
  if (def.targetFactor === undefined) return undefined;
  if (isStructure) {
    out.shield = out.hull = weaponTargetFactor(def, 'structure');
  } else {
    out.shield = weaponTargetFactor(def, 'shield');
    out.hull = weaponTargetFactor(def, 'hull');
  }
  return out;
}

export interface HitscanWeaponDef extends WeaponDefBase {
  mode: 'hitscan';
  range: number;
  /** Optional "optimal + beyond" damage falloff. `range` is the OPTIMAL
   *  range: FULL `damage` out to it. BEYOND it, applied damage falls LINEARLY
   *  to `minDamageFrac × damage` at `range × maxRangeMul` — the max reach
   *  the ray casts to; past that there is no hit. `maxRangeMul` defaults to 1
   *  (no beyond-optimal band ⇒ flat full damage everywhere in range). Absent
   *  falloff ⇒ flat damage. SERVER-AUTHORITATIVE — the client reads the scaled
   *  number off the `DamageEvent`, never predicts it (avoids desync). */
  falloff?: { minDamageFrac: number; maxRangeMul?: number };
  hitWidth?: number; // it hits all this width covers (`beamHalfWidth`, Weapons.ts); absent ⇒ a thin line
}

/** A weapon's kill cut (`WeaponDefBase.killCut`). `width` in world units:
 *  a channel's strip; a slice with a width erases a strip that wide too (the
 *  heavy beam, fracture v10), without one it is a zero-width line. */
export type WeaponKillCut = { kind: 'slice'; width?: number } | { kind: 'channel'; width: number };

export { HEAVY_BEAM_WIDTH, MINING_LASER_WIDTH, isCapitalTurretWeapon } from './capitalTurretDefs.js';

export interface ProjectileWeaponDef extends WeaponDefBase {
  mode: 'projectile';
  speed: number;
  radius: number;
  maxTicks: number;
  /** Optional blast where the shell hits (plan coastal-defences: the 80 cm
   *  siege gun). On a hit (only; a miss ends silently at the end of its
   *  flight, owner 2026-11-10), every other
   *  ship and structure within `radius` takes `damage × (falloffMin / d)²`
   *  (capped at full damage inside `falloffMin`). Absent ⇒ a plain shell. */
  splash?: { radius: number; falloffMin: number };
}

/** Heat-seeking missile weapon. Locked at launch via `pickTarget`, chases the
 *  target until it dies/leaves range or the missile expires. Slow speed +
 *  wide turn radius so players can dodge. On impact: inverse-square splash
 *  damage + kinetic impulse via the physics worker's `MISSILE_IMPULSE`
 *  command. See docs/architecture/missile-simulation.md. */
export interface MissileWeaponDef extends WeaponDefBase {
  mode: 'missile';
  /** Linear speed (units/sec). Slow enough to be dodgeable — 400 at 60Hz
   *  ≈ 6.67 u/tick, well below ship-radius 12 so no tunneling. */
  speed: number;
  /** Collision radius for direct-hit sweep. */
  radius: number;
  /** Lifetime in physics ticks. On expiry the missile is despawned
   *  WITHOUT detonating (impact-only — smoke handoff 2026-06-06, Issue 2):
   *  a missile that never hits fizzles out, it does not splash in-place.
   *  The cap still exists so a never-hitting missile doesn't fly forever. */
  lifetimeTicks: number;
  /** Maximum homing yaw clamp (rad/sec). Wider turn radius = dodgeable. */
  turnRate: number;
  /** Splash damage falloff radius. Damage falls off as `(splashFalloffMin/dist)²`
   *  inside this radius; zero outside. */
  splashRadius: number;
  /** Inner clamp on `dist` so the inverse-square doesn't divide by zero
   *  at point-blank. Damage at `dist <= splashFalloffMin` is exactly `damage`. */
  splashFalloffMin: number;
  /** Peak kinetic impulse magnitude (at `splashFalloffMin`). Falls off with
   *  the same inverse-square as damage. */
  splashImpulse: number;
  /** Extra damage applied to a primary (directly-struck or proximity-fused)
   *  target on top of the splash component. */
  directImpulseBonus: number;
  /** Skip the owner ship during splash damage/impulse (defaults true). */
  splashExcludeOwner: boolean;
  /** Detonate when within this radius of the locked target. Allows near-miss
   *  detonations to feel meaningful (dodgeable but not useless). Set to 0 to
   *  disable proximity-fusing (direct-hit-only behaviour). */
  proximityFuseRadius: number;
}

export type WeaponDef = HitscanWeaponDef | ProjectileWeaponDef | MissileWeaponDef;

const HITSCAN_DEF: HitscanWeaponDef = {
  id: 'hitscan',
  displayName: 'Beam',
  mode: 'hitscan',
  // Server-side fire cadence stays at 6 Hz (cooldownTicks=10 @ 60 Hz =
  // 167 ms inter-shot). The first smooth-beam retune (2026-05-22) tried
  // 4 HP × 33 ms to make the feel continuous, but it scaled DRONE fire
  // identically (the server uses one catalogue for both) and the 5×
  // wire-event amplification (laser_fired + damage broadcasts per
  // shooter × 25 drones in a populated sector) re-triggered the
  // 110 ms compositor stall pattern on touch devices — capture
  // `o4n4pw` 2026-05-22 vs `iph9cv` baseline. Reverted to keep wire
  // load low; the smooth feel is now produced CLIENT-SIDE via visual
  // damage-number splitting in `ColyseusClient.sendFire` (one server
  // fire → N small predicted ticks spread across the cooldown window,
  // tagged with the same `clientShotId` so existing
  // `reconcileDamageToFeedback` / `cancelByTag` handle the
  // confirmation / rollback unchanged). Wire load = baseline. Feel =
  // smooth. Drones + players use the same code path.
  //
  // Weapons/energy/AI overhaul (2026-06-01, plan:
  // weapons-energy-ai-overhaul §2): the BEAM is now the interceptor's
  // very-close-range duellist. Range dropped 500 → 250 (knife-fight
  // distance); per-beam damage 20 → 13 so a single-beam ship would kill
  // a 300-HP fighter in ~4 s at 6 Hz while the interceptor's TWIN beams
  // (two mounts, one slot trigger) land that in ~2 s — its "high DPS,
  // low hull" identity. NOTE: drones share this catalogue, and the
  // weapon-aware drone fire range in `HostileDroneBehaviour` derives
  // from this `range` for beam drones (close-in attackers).
  damage: 13,
  cooldownTicks: 10,
  range: 250,
  // "optimal + beyond", LINEAR (Equinox laser issue, 2026-06-14): FULL 13 damage
  // out to the 250 u OPTIMAL range, then a LINEAR drop-off to 15 % (≈2) at
  // maxRange = 250×1.3 = 325 u (where the ray ends). maxRangeMul tightened
  // 1.5 → 1.3 so the beam's beyond-optimal fringe is a SHORT, clearly-terminating
  // tail that fades to nothing well within view — the 1.5× (375 u) tail ran to the
  // screen edge and read as "renders infinitely". The CLIENT beam visual taper
  // (BeamSpritePool) draws solid to optimal then fades to nothing across
  // optimal→maxRange, so the visible taper == this damage band. Tunable;
  // server-authoritative (client reads the scaled damage off DamageEvent).
  falloff: { minDamageFrac: 0.15, maxRangeMul: 1.3 },
  // Beam slot trigger cost — interceptor full-pool sustain ≈ 6 s
  // (energyMax 180 / (5 × 6 Hz)). One slot trigger drains 5 regardless
  // of the twin mounts.
  energyCost: 5,
};

const LASER_DEF: ProjectileWeaponDef = {
  id: 'laser',
  displayName: 'Bolt',
  mode: 'projectile',
  // Weapons/energy/AI overhaul (2026-06-01, §2): BOLTS are the workhorse
  // for scout / fighter / heavy / gunship. Medium range, dodgeable, ~4 s
  // kill on a 300-HP fighter at 6 shots/s ⇒ ~25 hits ⇒ damage 12. Range
  // = speed × maxTicks / 60 = 1600 × 42 / 60 ≈ 1120 u (medium; was 2400).
  damage: 12,
  cooldownTicks: 10,
  speed: 1600,
  radius: 3,
  maxTicks: 42,
  // Bolt slot trigger cost — full-pool sustain 10-15 s for bolt ships
  // (e.g. scout energyMax 120 / (2 × 6 Hz) = 10 s).
  energyCost: 2,
};

/** P2d (plan soft-leaping-truffle v3) — kinetic shells from the Autocannon
 *  Turret. A physical projectile, so the turret spends MUNITIONS (lasers only
 *  spend power — user ruling 2026-11-01). Range ≈ 1400 × 36 / 60 = 840 u. */
const AUTOCANNON_DEF: ProjectileWeaponDef = {
  id: 'autocannon',
  displayName: 'Autocannon',
  mode: 'projectile',
  damage: 10,
  cooldownTicks: 6,
  speed: 1400,
  radius: 3,
  maxTicks: 36,
  // Turret-only today (turrets are not energy-gated); a nominal cost keeps the
  // catalogue rule (every weapon costs energy) for any future ship mount.
  energyCost: 1,
};

const HEAT_SEEKER_DEF: MissileWeaponDef = {
  id: 'heat-seeker',
  displayName: 'Heat-Seeker',
  mode: 'missile',
  // Direct-hit damage. The primary target also gets `directImpulseBonus`
  // additive damage on top of the splash component; near-miss splash
  // damage uses the inverse-square falloff against `damage` alone.
  //
  // Weapons/energy/AI overhaul (2026-06-01, §2): MISSILES kill most ships
  // in 1-2 hits. A salvo = 2 missiles (one slot trigger). With no-spillover
  // shields, one 150-damage missile is fully absorbed by a ≤150 shield
  // (dropping it to 0); the second lands on hull — so a 2-missile salvo
  // kills the common ≤300-HP ships (scout/fighter/interceptor). Was 30.
  damage: 150,
  // 90 ticks = ~1.5 s per mount cooldown (was 180/3 s). Sized so the
  // salvo cadence sustains ~8 missiles in flight over the 6 s TTL
  // (≈4 salvos / 6 s), the reverse-engineered "8 in flight" target
  // (plan §3.4). The frigate's energy pool + steady regen pace the real
  // throughput; cooldown is the floor.
  cooldownTicks: 90,
  // Missile slot trigger cost — frigate energyMax 240 / 60 = ~4-salvo
  // opening burst, then regen-paced (energyRegenRate 0.67 × 90 ticks ≈
  // one slot cost per cooldown window). Costs once at launch; no refund,
  // no in-flight cap (plan §3.4).
  energyCost: 60,
  // 400 u/s = 6.67 u/tick. Dodgeable but not slow enough to be a joke.
  speed: 400,
  // Collision radius small; missile is a point-thing visually.
  radius: 4,
  // 360 ticks = 6 s lifetime. Range at top speed ≈ 2400 u (well past
  // hitscan beam range of 500). Long enough to make dumb-mode missiles
  // a meaningful waste-of-shot.
  lifetimeTicks: 360,
  // 1.5 rad/s yaw clamp (playtest 2026-06-10 Issue 10: "missiles should bias
  // tracking the closest enemy a lot more" → tighter homing). Turn radius =
  // speed/turnRate = 400/1.5 ≈ 267 u (was 400 u at 1.0). Paired with mid-flight
  // re-acquisition in MissileSimulation.advance (a lost lock re-chases the
  // nearest hostile instead of flying straight forever) — together they make
  // missiles meaningfully track. Was briefly 1.0 (smoke 2026-06-06 dodgeability
  // pass); the playtest found that, combined with no re-acquisition, missiles
  // felt useless. A turning target can still out-manoeuvre at 1.5; this is a
  // gameplay knob — revisit after the next playtest. Do NOT confuse with the
  // frigate MOUNT rotationSpeed (turret slew) in shipKinds/missileFrigate.ts.
  turnRate: 1.5,
  splashRadius: 60,
  splashFalloffMin: 10,
  splashImpulse: 30,
  directImpulseBonus: 20,
  splashExcludeOwner: true,
  // Impact-only (smoke handoff 2026-06-06, Issue 2: "make it only explode
  // on impact"). 0 disables the proximity fuse → only a direct sweep hit
  // (`advance()` step 5) detonates; a near-miss flies past without
  // exploding. Splash still applies on a real hit. Paired with the
  // non-damaging lifetime expiry in MissileSimulation.advance() step 6.
  proximityFuseRadius: 0,
};

/**
 * Living World P3 — the robot NEXUS's weapon: a slow, fat, hard-hitting orb.
 * Easy to see coming and dodge (speed 700, radius 10) but punishing to tank
 * (45 per hit). NPC-only — not in the player mount/fire schemas. Range ≈
 * 700 × 120 / 60 = 1400 u.
 */
const PULSE_ORB_DEF: ProjectileWeaponDef = {
  id: 'pulse-orb',
  displayName: 'Pulse Orb',
  mode: 'projectile',
  damage: 45,
  cooldownTicks: 45,
  speed: 700,
  radius: 10,
  maxTicks: 120,
  // NPCs aren't energy-gated; the catalogue still requires a real cost.
  energyCost: 8,
};

/**
 * Living World P3c — the robot orb's CHARGE LASER: a 1.2 s visible wind-up,
 * then a heavy beam along the direction locked when the charge began (move and
 * it misses). NPC-only. 60 damage, 2.5 s cooldown.
 */
const CHARGE_LASER_DEF: HitscanWeaponDef = {
  id: 'charge-laser',
  displayName: 'Charge Laser',
  mode: 'hitscan',
  damage: 60,
  cooldownTicks: 150,
  range: 520,
  energyCost: 10,
  chargeTicks: 72,
};

/**
 * Weapon distances under the ship scale's combat profile (shipScale/config):
 * reach (hitscan range, projectile / missile flight time) and splash. Profile
 * A, or scale 1, returns the definition unchanged. Pure.
 */
export function scaleWeaponDef<T extends WeaponDef>(def: T, reach: number, splash: number): T {
  if (reach === 1 && splash === 1) return def;
  if (def.mode === 'hitscan') return { ...def, range: def.range * reach };
  if (def.mode === 'projectile') {
    const out: ProjectileWeaponDef = { ...def, maxTicks: Math.round(def.maxTicks * reach) };
    if (def.splash) out.splash = { radius: def.splash.radius * splash, falloffMin: def.splash.falloffMin * splash };
    return out as T;
  }
  return {
    ...def,
    lifetimeTicks: Math.round(def.lifetimeTicks * reach),
    splashRadius: def.splashRadius * splash,
    proximityFuseRadius: def.proximityFuseRadius * splash,
  };
}

const COMBAT = combatDistanceScale();
/** Sub-capital weapons only: the `naval_*` guns are absolute (navalGuns.ts). */
const profiled = <T extends WeaponDef>(d: T): T => scaleWeaponDef(d, COMBAT.reach, COMBAT.splash);

export const WEAPONS: ReadonlyMap<WeaponId, WeaponDef> = new Map<WeaponId, WeaponDef>([
  ['hitscan', profiled(HITSCAN_DEF)],
  ['laser', profiled(LASER_DEF)],
  ['heat-seeker', profiled(HEAT_SEEKER_DEF)],
  ['pulse-orb', profiled(PULSE_ORB_DEF)],
  ['charge-laser', profiled(CHARGE_LASER_DEF)],
  ['autocannon', profiled(AUTOCANNON_DEF)],
  ...CAPITAL_TURRET_DEFS.map((d): [WeaponId, WeaponDef] => [d.id, d]),
  ['tractor', TRACTOR_DEF],
]);

export const WEAPON_IDS: readonly WeaponId[] = ['hitscan', 'laser', 'heat-seeker', 'pulse-orb', 'charge-laser', 'autocannon', 'naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege', 'railgun', 'heavy_beam', 'mining_laser', 'tractor'] as const;

export const DEFAULT_WEAPON: WeaponId = 'hitscan';

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS.get(id) ?? WEAPONS.get('hitscan')!;
}

export function isWeaponId(v: unknown): v is WeaponId {
  return typeof v === 'string' && (WEAPON_IDS as readonly string[]).includes(v);
}

/** Is `id` a MINING TOOL (read from the record: it mines rock, a 'rock'
 *  factor above 0, or it is a tractor)? Only mining tools pass through loot
 *  pods (owner rule): the mining laser and the tractor, never a gun. Server
 *  shots (`ProjectilePipeline`, `PlayerFireResolver`) and the client's drawn
 *  beam (`displayPoseHitscan`) all ask this one predicate (#15). */
export function isMiningTool(id: WeaponId | undefined): boolean {
  if (id === undefined) return false;
  const def = WEAPONS.get(id);
  return def !== undefined && (def.tractor !== undefined || weaponTargetFactor(def, 'rock') > 0);
}

/**
 * Maximum range (world units) at which auto-fire should engage a target with
 * this weapon. Per-mode so each weapon "shoots when in its own reach":
 *
 *   - hitscan:    the beam's `range` (instant, exact).
 *   - projectile: `speed * maxTicks / 60` (the bolt's max travel) × 0.85 so
 *     auto-fire only opens up where the bolt can realistically still land
 *     before its lifetime expires (a target at the very edge usually drifts
 *     out before the bolt arrives).
 *   - missile:    `speed * lifetimeTicks / 60` × 0.5 — homing missiles can
 *     reach much farther, but auto-firing them at full lifetime range wastes a
 *     scarce, expensive salvo on shots likely to be dodged/expire; cap engage
 *     range to half the theoretical reach.
 *
 * Pure + allocation-free (scalar in/out) — safe to call in the fire-decision
 * hot path. The exhaustive `never` default makes a future weapon mode a
 * compile error rather than a silent `undefined`.
 */
export function weaponAutoFireRange(def: WeaponDef): number {
  switch (def.mode) {
    case 'hitscan':
      return def.range;
    case 'projectile':
      return projectileEngageReach(def.speed, def.maxTicks);
    case 'missile':
      return ((def.speed * def.lifetimeTicks) / 60) * 0.5;
    default: {
      const _exhaustive: never = def;
      return _exhaustive as never;
    }
  }
}

/**
 * "Optimal + beyond" hitscan damage falloff fraction in [minDamageFrac, 1].
 * FULL (1.0) out to `optimalRange`, then falling LINEARLY in the normalized
 * over-optimal distance to `minDamageFrac` at `maxRange`, clamped to
 * `minDamageFrac` past it. Pure + allocation-free (scalar in/out) — safe on the
 * fire-resolution path. Multiply the weapon's flat `damage` by this to get the
 * distance-scaled damage. A degenerate band (`maxRange <= optimalRange`) yields
 * 1.0 = flat full damage.
 *
 * LINEAR (Equinox laser issue, 2026-06-14; supersedes the P3.13 reverse-square).
 * The user's decision: a constant fall per unit of over-range distance reads as a
 * smooth, predictable taper that matches the visual beam taper — the reverse-
 * square's "slow then cliff" convex shape felt like damage "drops to 0 almost
 * instantly beyond range". Equal-width sub-bands now drop equal amounts.
 */
export function hitscanFalloffFrac(dist: number, optimalRange: number, maxRange: number, minDamageFrac: number): number {
  if (dist <= optimalRange) return 1;
  if (maxRange <= optimalRange) return 1;
  if (dist >= maxRange) return minDamageFrac;
  const t = (dist - optimalRange) / (maxRange - optimalRange);
  const frac = 1 - (1 - minDamageFrac) * t;
  return frac < minDamageFrac ? minDamageFrac : frac > 1 ? 1 : frac;
}
