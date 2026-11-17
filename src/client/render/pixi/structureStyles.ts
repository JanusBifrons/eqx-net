/**
 * Structure style directions (docs/plans/structure-restyle.md §4), chosen by
 * `?restyle=`. `current` is today's art (no entry: the plan is untouched).
 *
 * Adding a style (slices 1e, 1f) is ONE entry here: write its drawer table
 * (a `StructureStyleDef`, like `STYLE_A`) and add it under its id. The URL
 * reader, the bake key, the forge and the art lab all follow from this table.
 */
import type { StructureStyleDef, StyleDrawer } from './structureStyleKit.js';
import { STYLE_A } from './structureStyleA.js';
import { STYLE_C } from './structureStyleC.js';

export const STRUCTURE_STYLES = {
  a: STYLE_A,
  c: STYLE_C,
} as const satisfies Record<string, StructureStyleDef>;

export type StructureStyleId = 'current' | keyof typeof STRUCTURE_STYLES;

export const STRUCTURE_STYLE_IDS: readonly StructureStyleId[] = ['current', ...(Object.keys(STRUCTURE_STYLES) as Array<keyof typeof STRUCTURE_STYLES>)];

/** A `?restyle=` value as a style id; unknown or absent = `current`. */
export function parseStructureStyle(s: string | null | undefined): StructureStyleId {
  return (STRUCTURE_STYLE_IDS as readonly string[]).includes(s ?? '') ? (s as StructureStyleId) : 'current';
}

/** The style's drawer for a kind, or undefined (today's art). */
export function structureStyleDrawer(style: string | undefined, kindId: string): StyleDrawer | undefined {
  if (!style || style === 'current') return undefined;
  const def = (STRUCTURE_STYLES as Record<string, StructureStyleDef | undefined>)[style];
  return def?.kinds[kindId];
}
