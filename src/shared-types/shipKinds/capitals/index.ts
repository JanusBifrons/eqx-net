/**
 * The capital class (R&D, plan eager-sauteeing-curry): five WW2-grounded
 * warships, NPC-only. Built by `warshipDesign` for the current R&D arm
 * (`capitalConfig.ts`: style A|B|C, size mapping A|B). Appended to the
 * catalogue (invariant 11: append-only).
 */
import { defineCapitalShipKind } from '../../shipScale/defineShipKind.js';
import type { ShipKind } from '../types.js';
import { CAPITAL_MAP, CAPITAL_STYLE } from './capitalConfig.js';
import type { CapitalStyle } from './capitalConfig.js';
import { NAVAL_FIT, warshipDesign, type CapitalFit } from './warshipDesign.js';

const build = (id: Parameters<typeof warshipDesign>[0]): ShipKind =>
  defineCapitalShipKind(warshipDesign(id, CAPITAL_STYLE, CAPITAL_MAP).record);

export const DESTROYER: ShipKind = build('destroyer');
export const LIGHT_CRUISER: ShipKind = build('light-cruiser');
export const HEAVY_CRUISER: ShipKind = build('heavy-cruiser');
export const BATTLECRUISER: ShipKind = build('battlecruiser');
export const BATTLESHIP: ShipKind = build('battleship');

/**
 * Hull-style variants (wrap-up W2b, user 2026-11-08: keep all three styles
 * for variety). Each class's style B and C hulls are their own kinds, ids
 * `<class>-b` / `<class>-c`, appended to the catalogue, so the collider,
 * turrets, art, wrecks and the wire all work through the ordinary kind path.
 * The flagship director picks a style per ship. The base kinds keep the R&D
 * switch's style (default A).
 *
 * Fit variants (plan section 9): the same path with a weapon `fit` instead of
 * (or as well as) a hull style. A fitted kind's id ends in the fit's suffix
 * (`-rail`: railgun main battery) after any style suffix; a fitted kind on the
 * base hull (`style` omitted) takes the R&D switch's style like the base kind.
 */
const variant = (
  id: Parameters<typeof warshipDesign>[0], style: Exclude<CapitalStyle, 'A'> | null,
  fit: CapitalFit = NAVAL_FIT,
): ShipKind => {
  const styleSuffix = style ? `-${style.toLowerCase()}` : '';
  const fitSuffix = fit.main === 'railgun' ? '-rail' : '';
  return defineCapitalShipKind({
    ...warshipDesign(id, style ?? CAPITAL_STYLE, CAPITAL_MAP, fit).record, id: `${id}${styleSuffix}${fitSuffix}`,
  });
};

export const DESTROYER_B: ShipKind = variant('destroyer', 'B');
export const DESTROYER_C: ShipKind = variant('destroyer', 'C');
export const LIGHT_CRUISER_B: ShipKind = variant('light-cruiser', 'B');
export const LIGHT_CRUISER_C: ShipKind = variant('light-cruiser', 'C');
export const HEAVY_CRUISER_B: ShipKind = variant('heavy-cruiser', 'B');
export const HEAVY_CRUISER_C: ShipKind = variant('heavy-cruiser', 'C');
export const BATTLECRUISER_B: ShipKind = variant('battlecruiser', 'B');
export const BATTLECRUISER_C: ShipKind = variant('battlecruiser', 'C');
export const BATTLESHIP_B: ShipKind = variant('battleship', 'B');
export const BATTLESHIP_C: ShipKind = variant('battleship', 'C');

/** Plan section 9: the rail battleship, a battleship whose main battery is railguns. */
export const BATTLESHIP_RAIL: ShipKind = variant('battleship', null, { main: 'railgun', secondary: 'naval' });

/**
 * A capital class's kinds: its hull styles in order A, B, C (base kind first),
 * then its fitted variants. The flagship director picks one per ship, evenly.
 */
export const CAPITAL_STYLE_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  destroyer: ['destroyer', 'destroyer-b', 'destroyer-c'],
  'light-cruiser': ['light-cruiser', 'light-cruiser-b', 'light-cruiser-c'],
  'heavy-cruiser': ['heavy-cruiser', 'heavy-cruiser-b', 'heavy-cruiser-c'],
  battlecruiser: ['battlecruiser', 'battlecruiser-b', 'battlecruiser-c'],
  battleship: ['battleship', 'battleship-b', 'battleship-c', 'battleship-rail'],
};
