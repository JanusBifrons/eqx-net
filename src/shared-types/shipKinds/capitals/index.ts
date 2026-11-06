/**
 * The capital class (R&D, plan eager-sauteeing-curry): five WW2-grounded
 * warships, NPC-only. Built by `warshipDesign` for the current R&D arm
 * (`capitalConfig.ts`: style A|B|C, size mapping A|B). Appended to the
 * catalogue (invariant 11: append-only).
 */
import { defineCapitalShipKind } from '../../shipScale/defineShipKind.js';
import type { ShipKind } from '../types.js';
import { CAPITAL_MAP, CAPITAL_STYLE } from './capitalConfig.js';
import { warshipDesign } from './warshipDesign.js';

const build = (id: Parameters<typeof warshipDesign>[0]): ShipKind =>
  defineCapitalShipKind(warshipDesign(id, CAPITAL_STYLE, CAPITAL_MAP).record);

export const DESTROYER: ShipKind = build('destroyer');
export const LIGHT_CRUISER: ShipKind = build('light-cruiser');
export const HEAVY_CRUISER: ShipKind = build('heavy-cruiser');
export const BATTLECRUISER: ShipKind = build('battlecruiser');
export const BATTLESHIP: ShipKind = build('battleship');
