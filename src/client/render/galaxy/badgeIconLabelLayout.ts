/**
 * Pure layout math for the galaxy-map sector count badges (#16).
 *
 * The badge redesign: instead of a solid shape with the count KNOCKED OUT of its
 * centre, each present entity type renders a small per-type ICON (the shared
 * `entityVisuals` shape) with the count as a SEPARATE adjacent text LABEL to its
 * right — the "combatIcon" / crossed-swords style the user asked for. This keeps
 * the shared visual language (same shapes + colours) while making the count read
 * as a clean number beside the glyph rather than cramped inside it.
 *
 * This module is the unit-testable geometry (the GalaxyMapLayer holds the Pixi
 * `Graphics`/`Text` and reads these positions — the Phase A3 idiom). NO Pixi /
 * DOM here.
 */

/** Per-segment measurement: the icon's own width + the measured label width. */
export interface BadgeSegmentMeasure {
  /** Diameter of the icon shape (2 × icon radius). */
  iconW: number;
  /** Rendered width of the count label text (measured by the caller). */
  labelW: number;
}

/** Resolved per-segment placement, relative to the centred row's origin (0). */
export interface BadgeSegmentPlacement {
  /** The segment container's x (its local origin sits at the icon centre). */
  x: number;
  /** The icon centre x WITHIN the segment (local). Always 0 — the box origin is
   *  the icon centre so the icon Graphics draws at (0,0). */
  iconX: number;
  /** The label's x WITHIN the segment (local), left-anchored just past the icon. */
  labelX: number;
}

/** Total width of one segment = icon + gap (only if a label is present) + label. */
export function badgeSegmentWidth(m: BadgeSegmentMeasure, iconLabelGap: number): number {
  return m.iconW + (m.labelW > 0 ? iconLabelGap + m.labelW : 0);
}

/**
 * Lay out a centred row of icon+label segments.
 *
 * Each visible segment occupies `badgeSegmentWidth`; segments are separated by
 * `segGap`. The whole row is centred on x=0. Within a segment the icon centre is
 * the segment's local origin (so a Pixi `Graphics` drawn at (0,0) is the icon)
 * and the label is left-anchored `iconRadius + iconLabelGap` to the right.
 *
 * Returns one placement per input measure (index-aligned). Callers iterate their
 * visible segments in the SAME order they pass measures here.
 */
export function layoutBadgeIconLabelRow(args: {
  measures: readonly BadgeSegmentMeasure[];
  segGap: number;
  iconLabelGap: number;
}): BadgeSegmentPlacement[] {
  const { measures, segGap, iconLabelGap } = args;
  let total = 0;
  for (let i = 0; i < measures.length; i++) {
    total += badgeSegmentWidth(measures[i]!, iconLabelGap);
    if (i > 0) total += segGap;
  }
  // Walk left→right from the left edge of the centred row. `x` tracks the left
  // edge of the current segment; the icon centre sits half an icon-width in.
  const out: BadgeSegmentPlacement[] = [];
  let x = -total / 2;
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i]!;
    const iconCentreX = x + m.iconW / 2;
    out.push({
      x: iconCentreX,
      iconX: 0,
      // Label sits just past the icon's right edge (icon radius = iconW/2).
      labelX: m.iconW / 2 + iconLabelGap,
    });
    x += badgeSegmentWidth(m, iconLabelGap) + segGap;
  }
  return out;
}
