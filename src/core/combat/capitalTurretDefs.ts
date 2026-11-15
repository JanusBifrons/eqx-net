/**
 * The capital turret weapon records (naval guns, railgun, heavy beam, mining
 * laser), split out of WeaponCatalogue.ts like `tractorSpec.ts`. All are
 * absolute (never `profiled`); WeaponCatalogue folds `CAPITAL_TURRET_DEFS`
 * into `WEAPONS` and re-exports the public names below.
 */
import {
  NAVAL_GUN_BALLISTICS as NAVAL, NAVAL_SIEGE_SPLASH,
  RAILGUN_BALLISTICS, RAILGUN_BOLT_WIDTH, RAILGUN_RADIUS,
} from '../../shared-types/combat/navalGuns.js';
import type { HitscanWeaponDef, ProjectileWeaponDef, WeaponDef } from './WeaponCatalogue.js';

/** The heavy beam's width (world units): the strip its slice erases on a
 *  kill (`killCut`) and the client's drawn core width (`HEAVY_BEAM_STYLE`),
 *  so the gap and the beam that made it match (owner 2026-11-15: "the slice
 *  is too thin compared to the width of the beam"). */
export const HEAVY_BEAM_WIDTH = 60;

/**
 * Capital naval guns (plan prancy-squishing-donut Phase 3), one per mount size.
 * Ratios follow the WW2 calibres in docs/research/ww2-surface-combatants.md:
 *
 *   | size | gun     | shell   | max range | rate   |
 *   |------|---------|---------|-----------|--------|
 *   | S    | 5"/38   | 25 kg   | 16.6 km   | 15 rpm |
 *   | M    | 6"–8"   | ~100 kg | ~25.5 km  | 4–10   |
 *   | L    | 12"/50  | 517 kg  | 35 km     | 2.7    |
 *   | XL   | 16"/50  | 1225 kg | 38.7 km   | 2      |
 *
 * Reach keeps the real range ratio (1 : 1.54 : 2.12 : 2.34). Reloads are the
 * real ones (review round 2026-11-07): 16" 30 s, 12" 22 s, 6-8" 10 s, 5" 4 s.
 * Damage is scaled to match, so a 16" salvo is a heavy blow even to a capital
 * (a direct hit wipes a small ship's shields). Main guns never TARGET small
 * craft (core/combat/mountTargeting.ts), but a shell hits whatever it meets.
 * Shells fly 1.5-2.75 s to full reach: dodgeable.
 * Speed and flight time are ABSOLUTE (shared-types/combat/navalGuns.ts): the
 * naval guns are exempt from `profiled`, as capital hulls are from the ship
 * scale. The numbers are the shipped 2× B ones (flight = the old 1× × 1.5).
 */
const NAVAL_S_DEF: ProjectileWeaponDef = {
  id: 'naval_s', displayName: '5" gun', mode: 'projectile',
  damage: 60, cooldownTicks: 240, ...NAVAL.naval_s, radius: 3, energyCost: 1,
};
const NAVAL_M_DEF: ProjectileWeaponDef = {
  id: 'naval_m', displayName: '8" gun', mode: 'projectile',
  damage: 350, cooldownTicks: 600, ...NAVAL.naval_m, radius: 4, energyCost: 1,
};
const NAVAL_L_DEF: ProjectileWeaponDef = {
  id: 'naval_l', displayName: '12" gun', mode: 'projectile',
  damage: 800, cooldownTicks: 1320, ...NAVAL.naval_l, radius: 5, energyCost: 1,
};
const NAVAL_XL_DEF: ProjectileWeaponDef = {
  id: 'naval_xl', displayName: '16" gun', mode: 'projectile',
  damage: 1400, cooldownTicks: 1800, ...NAVAL.naval_xl, radius: 6, energyCost: 1,
};

/**
 * Coastal super-guns (plan coastal-defences), from
 * docs/research/ww2-coastal-defences.md. Land guns were not bigger in calibre
 * than the biggest battleship guns, but freed from a ship's stability limits
 * they elevated higher and reached further; the truly biggest guns were
 * railway siege guns.
 *
 *  - naval_xxl, Batterie Lindemann's 40.6 cm SK C/34: the light 600 kg coast
 *    shell reached 56 km (1.44× the Iowa's 38.7 km); damage from the 1,030 kg
 *    standard shell at the same 2 rounds a minute as the 16"/50.
 *  - naval_siege, Schwerer Gustav's 80 cm: a 4.8 t HE shell to 47 km, one shot
 *    in 30–45 minutes (capped here at 120 s). Its worth is the blast.
 */
const NAVAL_XXL_DEF: ProjectileWeaponDef = {
  id: 'naval_xxl', displayName: '40.6 cm coast gun', mode: 'projectile',
  damage: 1200, cooldownTicks: 1800, ...NAVAL.naval_xxl, radius: 7, energyCost: 1,
};
const NAVAL_SIEGE_DEF: ProjectileWeaponDef = {
  id: 'naval_siege', displayName: '80 cm siege gun', mode: 'projectile',
  damage: 4200, cooldownTicks: 7200, ...NAVAL.naval_siege, radius: 12, energyCost: 1,
  splash: { ...NAVAL_SIEGE_SPLASH },
};

/**
 * The capital RAILGUN (plan beam-slices §7, owner decisions 2026-11-14): a
 * main-battery turret for AI pilots. It charges ~6 s (a glow on the gun only,
 * no aim line), fires the moment the charge is done if the turret bears
 * (else holds it and fires when it bears again), then reloads for a long
 * time. The slug is a naval EVENT shell (`NAVAL_SHELL_WEAPON_IDS`): very fast
 * and flat (`RAILGUN_BALLISTICS`), small, heavy. A hit that doesn't kill
 * stops it; a kill erases a channel as wide as the drawn bolt along its line
 * (`killCut`) and the slug carries on at full damage (`ProjectilePipeline`
 * pass-through). Absolute like the naval guns (never `profiled`). One barrel
 * per turret, so the slug carries the turret's whole punch: 7500 kills any
 * shield-down capital up to a battlecruiser (a battleship takes two).
 */
const RAILGUN_DEF: ProjectileWeaponDef = {
  id: 'railgun', displayName: 'Railgun', mode: 'projectile',
  damage: 7500, cooldownTicks: 2400, ...RAILGUN_BALLISTICS, radius: RAILGUN_RADIUS, energyCost: 1,
  chargeTicks: 360, chargeRelease: 'when-bearing', chargeTelegraph: 'mount-glow',
  killCut: { kind: 'channel', width: RAILGUN_BOLT_WIDTH },
};

/**
 * The capital HEAVY BEAM (plan beam-slices §8, owner decisions 2026-11-14): a
 * sustained burn for the main or secondary battery of a capital design. It is
 * an ordinary hitscan weapon fired through the one beam path (`fireNow` →
 * the hitscan sink → `laser_fired`); "continuous" is just its 6 Hz cadence
 * (`cooldownTicks` 10, the floor set by the compositor-stall note on
 * `HITSCAN_DEF`). The only weapon whose beam kill slices the hull
 * (`killCut: slice`); fighter and sub-cap beams break up normally. Absolute
 * like the naval guns (never `profiled`). Its drawn thickness is a client
 * look (`beamStyles`), not a catalogue field.
 *
 * Numbers (capital pool: `energyMax` 600, `energyRegenRate` 2 / tick = 120/s,
 * `warshipDesign.ts`):
 *  - energy 45 per shot × 6 Hz = 270/s drain, net 270 − 120 = 150/s ⇒ a full
 *    pool burns 600 / 150 = 4 s, then regen paces it at 120 / 45 ≈ 2.7 shots/s.
 *  - damage 260 × 6 Hz = 1,560/s ⇒ one 4 s burn (24 shots) = 6,240: a heavy
 *    cruiser through full shields (4,018 hull + 2,009 shield = 6,027); a
 *    battlecruiser (≈ 10,900) takes about two burns, a battleship (≈ 17,000)
 *    three.
 *  - range 20,000 u: past the 5" secondary battery (≈ 16.6 km), short of the
 *    8" (≈ 25.5 km) and well short of the 12"/16" main guns (≈ 35 / 38.7 km),
 *    so big guns outrange it and a beam ship has to close.
 */
const HEAVY_BEAM_DEF: HitscanWeaponDef = {
  id: 'heavy_beam', displayName: 'Heavy beam', mode: 'hitscan',
  damage: 260, cooldownTicks: 10, range: 20_000, energyCost: 45,
  killCut: { kind: 'slice', width: HEAVY_BEAM_WIDTH },
  // Owner (game feel): "the beam should not turn after the kill and show for
  // half a second or one second through the clean cut": 0.75 s.
  followThroughTicks: 45,
};

/** The mining laser's slice width (world u): a quarter of the heavy beam's. */
export const MINING_LASER_WIDTH = HEAVY_BEAM_WIDTH / 4;

/**
 * The MINING LASER (plan partitioned-chasing-lark PR 7): a salvage beam (no
 * ship carries it yet), an ordinary hitscan beam like the heavy beam. Its
 * factors make it a tool: nothing on a raised shield, 5 % on a live hull or a
 * structure, full on a wreck piece (wear lands with PR 5); on a rock it
 * draws ore (the server's `OreDraw`; no other weapon mines); a hit its factor
 * zeroes is no hostile act (`SectorRoom.applyDamage`). Its narrow slice cuts
 * along the beam. 120 × 6 Hz = 720/s on a wreck, 36/s on a bare hull; energy
 * 12/shot = 72/s, under a capital's 120/s regen, so it holds on (the heavy
 * beam costs 45). Range 12,000 u, short of the heavy beam's 20,000; absolute
 * (never `profiled`), scaled per mount by `mountWeaponReach`.
 */
const MINING_LASER_DEF: HitscanWeaponDef = {
  id: 'mining_laser', displayName: 'Mining laser', mode: 'hitscan',
  damage: 120, cooldownTicks: 10, range: 12_000, energyCost: 12,
  killCut: { kind: 'slice', width: MINING_LASER_WIDTH },
  targetFactor: { shield: 0, hull: 0.05, structure: 0.05, wreck: 1, rock: 1 },
};

/**
 * The capital turret weapons: absolute (never `profiled`), carried only on
 * trained capital / coastal turrets (naval guns, railgun, heavy beam, mining
 * laser). Everything else is a sub-capital weapon, usually a fighter's fixed
 * gun. `isCapitalTurretWeapon` reads this list; the fire gate gives these the
 * turret bearing rule (`fireControlBearing.mountFireTolerance`).
 */
export const CAPITAL_TURRET_DEFS: readonly WeaponDef[] = [
  NAVAL_S_DEF, NAVAL_M_DEF, NAVAL_L_DEF, NAVAL_XL_DEF, NAVAL_XXL_DEF, NAVAL_SIEGE_DEF,
  RAILGUN_DEF, HEAVY_BEAM_DEF, MINING_LASER_DEF,
];

const CAPITAL_TURRET_WEAPON_IDS: ReadonlySet<string> = new Set(CAPITAL_TURRET_DEFS.map((d) => d.id));

/** Is `id` a capital turret weapon (absolute reach, trained turret mount)?
 *  Pure, allocation-free. */
export function isCapitalTurretWeapon(id: string): boolean {
  return CAPITAL_TURRET_WEAPON_IDS.has(id);
}
