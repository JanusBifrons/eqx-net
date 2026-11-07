/**
 * Naval turret geometry for capital ships (R&D, plan eager-sauteeing-curry),
 * by mount size (calibre class). One table for the hull generator (barbette
 * parts), the turret art (gunhouse + barrels) and the shared muzzle point
 * (`core/combat/muzzle.ts`), so a shot leaves the drawn barrel tip (#15).
 *
 * Every number is × the hull BEAM, from WW2 data:
 *  - XL (16"/50, Iowa, beam 33 m): barbette 37 ft 3 in (11.35 m ⇒ r 0.17);
 *    barrel 20.3 m (0.62); gunhouse ≈ 15 m wide (0.46), longer than wide.
 *  - L (12"/50, Alaska, beam 27.8 m): ≈ 0.42 wide, barrel ≈ 15 m (0.54).
 *  - M (6"/47 triple, Cleveland, beam 20.2 m; 8"/55, Baltimore): house
 *    ≈ 9 m (0.45), barrel 7–11 m (0.4).
 *  - S (5"/38 twin or single): house ≈ 4.5 m on a 33 m beam (0.14), barrel
 *    4.8 m (0.15). Destroyers carry it as their main battery (relatively
 *    bigger on a 12 m beam: the hull generator sizes their S mounts up).
 *
 * The gunhouse is centred on the pivot; barrels start at its front face, so
 * the muzzle is houseL / 2 + barrel length ahead of the pivot.
 * Sources: docs/research/ww2-surface-combatants.md (+ the 16"/50 Mark 7 page).
 */
export type CapitalTurretSize = 'AA' | 'S' | 'M' | 'L' | 'XL';

export interface CapitalTurretGeom {
  /** Gunhouse width and length. */
  houseW: number;
  houseL: number;
  /** Barbette (fixed ring under the turret) radius. */
  barbette: number;
  /** Barrel length (from the gunhouse front) and outer width. */
  len: number;
  wid: number;
}

export const CAPITAL_TURRETS: Readonly<Record<CapitalTurretSize, CapitalTurretGeom>> = {
  // AA: a quad 40 mm Bofors mount (~4.5 m across on a 33 m beam), 4 short barrels.
  AA: { houseW: 0.1, houseL: 0.08, barbette: 0.05, len: 0.075, wid: 0.009 },
  S: { houseW: 0.15, houseL: 0.17, barbette: 0.075, len: 0.16, wid: 0.022 },
  M: { houseW: 0.42, houseL: 0.46, barbette: 0.19, len: 0.38, wid: 0.04 },
  L: { houseW: 0.43, houseL: 0.48, barbette: 0.18, len: 0.52, wid: 0.045 },
  XL: { houseW: 0.46, houseL: 0.52, barbette: 0.17, len: 0.62, wid: 0.05 },
};

/** Destroyer main mounts are S calibre on a narrow beam: scale them up so a
 *  5" mount on a 12 m beam reads like Fletcher's (≈ 0.3 of the beam). */
export const DESTROYER_S_SCALE = 2;
