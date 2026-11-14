/**
 * Physical-ramming damage model (pure, SERVER-AUTHORITY-ONLY — same stance
 * as ShieldHull: the client never computes ramming damage).
 *
 * Why aggregation is load-bearing: once a ship's shield drops it collides
 * as its hull polygon, which Rapier models as a COMPOUND of N triangle
 * colliders. One physical ram therefore emits up to N contact-force
 * sub-events in the same tick, all with the same {aId,bId} but each
 * carrying only that triangle-pair's fraction of the total force. If the
 * damage model ran per raw event it would MULTIPLY damage by the number of
 * triangles in contact (orientation-dependent). So we collapse sub-events
 * per unordered {aId,bId} pair per tick FIRST, then damage, then broadcast —
 * exactly once per body pair per tick.
 *
 * Damage curve: IMPACT-BASED, ramming as a weapon (owner decision 2026-11-13,
 * replacing the 2026-06-12 WS-1/R2.31 mass-differential model, under which two
 * equal ships dealt 0 at any speed and the angle of the hit was ignored —
 * "You're telling me speed and angle of attack have no bearing? Wtf?!").
 *
 *   vN      = closing speed ALONG THE CONTACT NORMAL (Contact.normalSpeed):
 *             head-on ⇒ the full closing speed; a glancing scrape ⇒ |v|·sin(θ)
 *   μ       = mA·mB / (mA + mB)                    (reduced mass)
 *   E       = ½ · μ · max(0, vN − RAM_MIN_IMPACT_SPEED)²
 *             — the kinetic energy of the normal approach, which is what a
 *             collision can turn into damage. Below the floor a bump is free;
 *             subtracting the floor keeps the curve continuous.
 *   total   = RAM_DAMAGE_PER_ENERGY · E
 *   damageTo(self) = min(RAM_DAMAGE_MAX, total · mOther / (mSelf + mOther))
 *             — equal masses split 50/50, the lighter ship always takes more,
 *             a fighter into a capital takes ~all of it.
 *
 * Physics note (why a parked capital is not a one-shot): two equal ships
 * head-on at speed v each take exactly what one of them would take flying
 * into an immovable wall at v. So a fighter at full speed into a PARKED
 * capital takes about what each side of a full-speed fighter head-on takes;
 * an ONCOMING capital adds its own speed to vN and hurts far more.
 *
 * Calibration (2× default ship scale): a fighter (mass 8, top speed ~601 u/s,
 * boosted top ~565 u/s,
 * shield 263 + hull 263 since the 2026-11-13 arcade toughness layer) head-on
 * with another at both ships' full speed
 * (vN ≈ 1202) ⇒ ~291 each (~55 % of its 525 pool; ~256 at the boosted top
 * speed). Both ram constants were scaled ×1.75 with the fighter pool so the
 * #558 calibration ("ramming as a weapon") holds while every other fight got
 * longer (owner 2026-11-13: "make fights a bit longer"). Speeds and masses both
 * follow ship size (#18: mass ∝ s³, top speed ∝ √(1/s)), so the floor is a
 * plain speed and the masses come from the bodies. Constants are tuning
 * values; the regression lock is the SHAPE (normal-speed driven, angle
 * monotone, weight split, floor, ceiling, aggregation), not exact numbers.
 */

import type { Contact } from '../physics/contactDrain.js';

/** NORMAL closing speed (game u/s) at or below which a collision deals NO
 *  damage — a slow drift / docking tap / light scrape is free. */
export const RAM_MIN_IMPACT_SPEED = 50;
/** Damage per unit of normal impact energy (½·μ·(vN − floor)², game units).
 *  Tuned so a full-speed fighter head-on removes ~55 % of each fighter's
 *  combined shield + hull (see the header). The "ramming as a weapon" knob. */
export const RAM_DAMAGE_PER_ENERGY = 2.1875e-4;
/** Hard cap on ramming damage to ONE body per body-pair per tick. High enough
 *  that a fighter can be crushed outright by an oncoming capital (its pool is
 *  525 since the arcade toughness layer; the cap was 400 when it was 300), low enough that
 *  two capitals colliding don't one-shot each other. */
export const RAM_DAMAGE_MAX = 700;
/** Converts the contact's aggregated FORCE to an impact SPEED when the worker
 *  did not supply a measured closing speed (old captures / replay). When
 *  `Contact.normalSpeed` / `impactSpeed` is present it is used instead. */
export const FORCE_PER_UNIT_SPEED = 60;

/** Normal impact energy ½·μ·(vN − floor)² for two bodies of mass `massA` /
 *  `massB`. 0 at/below the floor, and 0 when either mass is absent/zero (an
 *  unregistered body: the safe legacy/replay fallback deals nothing). */
export function ramImpactEnergy(normalSpeed: number, massA: number, massB: number): number {
  if (!(massA > 0) || !(massB > 0)) return 0;
  const over = normalSpeed - RAM_MIN_IMPACT_SPEED;
  if (!(over > 0)) return 0;
  const mu = (massA * massB) / (massA + massB);
  return 0.5 * mu * over * over;
}

/** The fraction of a collision's damage that the body of mass `massSelf`
 *  takes: mOther / (mSelf + mOther). Equal ⇒ ½; lighter self ⇒ more. */
export function ramShareTo(massSelf: number, massOther: number): number {
  const sum = massSelf + massOther;
  return sum > 0 ? massOther / sum : 0;
}

/** Damage dealt TO the body of mass `massSelf` when it hits a body of mass
 *  `massOther` with normal closing speed `normalSpeed`. Capped at
 *  RAM_DAMAGE_MAX. */
export function ramDamageTo(normalSpeed: number, massSelf: number, massOther: number): number {
  const d = RAM_DAMAGE_PER_ENERGY * ramImpactEnergy(normalSpeed, massSelf, massOther) * ramShareTo(massSelf, massOther);
  return d > RAM_DAMAGE_MAX ? RAM_DAMAGE_MAX : d;
}

export interface RamPair {
  /** Canonical ids from the highest-force sub-event of the pair (so the
   *  post-collision velocities line up with aId/bId for collision_resolved). */
  aId: string;
  bId: string;
  /** Summed contact-force magnitude across every sub-event of the pair. */
  force: number;
  /** |relative velocity| closing speed (game u/s), measured or force-derived.
   *  Diagnostic since 2026-11-13; the damage keys off `normalSpeed`. */
  impactSpeed: number;
  /** Normal closing speed (game u/s) that drove the damage: the MAX over the
   *  pair's sub-contacts, falling back to impactSpeed when absent. */
  normalSpeed: number;
  vA: { x: number; y: number };
  vB: { x: number; y: number };
  /** Damage to body A (A's mass as self) and to body B. Both > 0 for a hard
   *  hit between equal ships; the lighter body's value is the larger. */
  damageA: number;
  damageB: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? a + '\u0000' + b : b + '\u0000' + a;
}

/**
 * Collapse a tick's raw contact list into one entry per unordered body pair.
 * Deterministic: iteration order of the input does not change the summed
 * force, the max normal speed, or the chosen representative (the
 * max-single-force sub-event), and the damage is a pure function of those.
 */
export function aggregateRamming(contacts: ReadonlyArray<Contact>): RamPair[] {
  const m = new Map<string, { rep: Contact; force: number; normal: number | undefined }>();
  for (const c of contacts) {
    const key = pairKey(c.aId, c.bId);
    const e = m.get(key);
    if (e === undefined) {
      m.set(key, { rep: c, force: c.forceMagnitude, normal: c.normalSpeed });
    } else {
      e.force += c.forceMagnitude;
      if (c.forceMagnitude > e.rep.forceMagnitude) e.rep = c;
      // Each sub-contact (triangle) has its own normal; the hardest-hitting
      // one is the impact. Symmetric in a/b order (both vectors flip).
      if (c.normalSpeed !== undefined && (e.normal === undefined || c.normalSpeed > e.normal)) e.normal = c.normalSpeed;
    }
  }
  const out: RamPair[] = [];
  for (const { rep, force, normal } of m.values()) {
    // Prefer the worker-MEASURED speeds; fall back to the force-derived
    // estimate for contacts that predate them (old captures / replay).
    const impactSpeed = rep.impactSpeed ?? force / FORCE_PER_UNIT_SPEED;
    const normalSpeed = normal ?? impactSpeed;
    // Masses are per-body; the representative carries the pair's values.
    const aMass = rep.aMass ?? 0;
    const bMass = rep.bMass ?? 0;
    out.push({
      aId: rep.aId,
      bId: rep.bId,
      force,
      impactSpeed,
      normalSpeed,
      vA: { x: rep.vAxPost, y: rep.vAyPost },
      vB: { x: rep.vBxPost, y: rep.vByPost },
      damageA: ramDamageTo(normalSpeed, aMass, bMass),
      damageB: ramDamageTo(normalSpeed, bMass, aMass),
    });
  }
  return out;
}
