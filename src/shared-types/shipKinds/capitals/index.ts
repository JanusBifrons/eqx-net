/**
 * The capital class (R&D, plan eager-sauteeing-curry): five WW2-grounded
 * warships. Built by `warshipDesign` for the current R&D arm
 * (`capitalConfig.ts`: style A|B|C, size mapping A|B). Appended to the
 * catalogue (invariant 11: append-only).
 *
 * Player capitals (owner 2026-11-17): the five classes and the three fits
 * (rail battleship, beam cruiser, lance battlecruiser) are pilotable and free
 * on the ship screen (`STARTER_HULL_KINDS`), never in a random spawn pool
 * (owned only, `randomSpawn: false`). The -b / -c hull styles stay NPC-only.
 */
import { defineCapitalShipKind } from '../../shipScale/defineShipKind.js';
import type { ShipKind } from '../types.js';
import { CAPITAL_MAP, CAPITAL_STYLE } from './capitalConfig.js';
import type { CapitalStyle } from './capitalConfig.js';
import { NAVAL_FIT, warshipDesign, type CapitalFit } from './warshipDesign.js';
import { BARGE_KIND_ID, BARGE_PICK, bargeDesign } from './bargeDesign.js';
import { BARGE_LOOK } from './bargeLookConfig.js';

/** A player-pilotable capital: in the picker, never in a random spawn pool. */
const PILOTABLE = { npcOnly: false, randomSpawn: false } as const;

const build = (id: Parameters<typeof warshipDesign>[0]): ShipKind =>
  defineCapitalShipKind({ ...warshipDesign(id, CAPITAL_STYLE, CAPITAL_MAP).record, ...PILOTABLE });

export const DESTROYER: ShipKind = build('destroyer');
export const LIGHT_CRUISER: ShipKind = build('light-cruiser');
export const HEAVY_CRUISER: ShipKind = build('heavy-cruiser');
export const BATTLECRUISER: ShipKind = build('battlecruiser');
export const BATTLESHIP: ShipKind = build('battleship');

/** A fitted kind's main-battery id suffix (`variant`). */
const MAIN_FIT_SUFFIX: Readonly<Record<CapitalFit['main'], string>> = { naval: '', railgun: '-rail', beam: '-lance' };

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
 * after any style suffix: the main battery's (`-rail` railguns, `-lance` heavy
 * beams), then the secondaries' (`-beam` heavy beams). A fitted kind on the
 * base hull (`style` omitted) takes the R&D switch's style like the base kind,
 * and is pilotable like it; a styled hull stays NPC-only.
 */
const variant = (
  id: Parameters<typeof warshipDesign>[0], style: Exclude<CapitalStyle, 'A'> | null,
  fit: CapitalFit = NAVAL_FIT,
): ShipKind => {
  const styleSuffix = style ? `-${style.toLowerCase()}` : '';
  const fitSuffix = MAIN_FIT_SUFFIX[fit.main] + (fit.secondary === 'beam' ? '-beam' : '');
  return defineCapitalShipKind({
    ...warshipDesign(id, style ?? CAPITAL_STYLE, CAPITAL_MAP, fit).record, id: `${id}${styleSuffix}${fitSuffix}`,
    ...(style === null ? PILOTABLE : {}),
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
/** Plan section 9: the beam cruiser, a heavy cruiser whose secondaries are heavy beams. */
export const HEAVY_CRUISER_BEAM: ShipKind = variant('heavy-cruiser', null, { main: 'naval', secondary: 'beam' });
/** Plan section 9: the lance battlecruiser, a battlecruiser whose main battery is heavy beams. */
export const BATTLECRUISER_LANCE: ShipKind = variant('battlecruiser', null, { main: 'beam', secondary: 'naval' });

/**
 * A capital class's kinds: its hull styles in order A, B, C (base kind first),
 * then its fitted variants. The flagship director picks one per ship, evenly.
 */
export const CAPITAL_STYLE_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  destroyer: ['destroyer', 'destroyer-b', 'destroyer-c'],
  'light-cruiser': ['light-cruiser', 'light-cruiser-b', 'light-cruiser-c'],
  'heavy-cruiser': ['heavy-cruiser', 'heavy-cruiser-b', 'heavy-cruiser-c', 'heavy-cruiser-beam'],
  battlecruiser: ['battlecruiser', 'battlecruiser-b', 'battlecruiser-c', 'battlecruiser-lance'],
  battleship: ['battleship', 'battleship-b', 'battleship-c', 'battleship-rail'],
};

/**
 * The mining barge (plan partitioned-chasing-lark PR 15): the owner's pick of
 * the look options (A, a container ship) as a real, pilotable kind. No
 * allegiance (its side comes from its owner) and never in a random spawn pool.
 */
export const BARGE: ShipKind = defineCapitalShipKind(bargeDesign(BARGE_PICK, CAPITAL_MAP, BARGE_KIND_ID).record);

/**
 * Mining-barge look R&D (plan partitioned-chasing-lark, PR 14): the look the
 * dev switch `?bargeLook=` / `EQX_BARGE_LOOK` picks, or null when it is off
 * (the default). `catalogueOrder.ts` appends it at the very end only when set.
 */
export const BARGE_LOOK_KIND: ShipKind | null = BARGE_LOOK ? defineCapitalShipKind(bargeDesign(BARGE_LOOK, CAPITAL_MAP).record) : null;
