import { describe, it, expect } from 'vitest';
import {
  badgeSegmentWidth,
  layoutBadgeIconLabelRow,
  type BadgeSegmentMeasure,
} from './badgeIconLabelLayout';

/**
 * #16 — galaxy-map sector badges are now ICON + ADJACENT LABEL (not a count
 * knocked out of the shape's centre). This locks the pure layout geometry: each
 * segment is icon + gap + label, and the row of visible segments is centred.
 */
describe('badgeSegmentWidth', () => {
  it('is icon + gap + label when a label is present', () => {
    expect(badgeSegmentWidth({ iconW: 12, labelW: 8 }, 3)).toBe(12 + 3 + 8);
  });
  it('is icon-only when there is no label (labelW 0 — no trailing gap)', () => {
    expect(badgeSegmentWidth({ iconW: 12, labelW: 0 }, 3)).toBe(12);
  });
});

describe('layoutBadgeIconLabelRow (#16 icon + adjacent label)', () => {
  it('centres a single segment on x=0', () => {
    const measures: BadgeSegmentMeasure[] = [{ iconW: 12, labelW: 8 }];
    const [seg] = layoutBadgeIconLabelRow({ measures, segGap: 4, iconLabelGap: 3 });
    // segment width = 12+3+8 = 23, centred ⇒ left edge -11.5, icon centre at -11.5+6 = -5.5
    expect(seg!.x).toBeCloseTo(-5.5, 6);
    expect(seg!.iconX).toBe(0); // icon drawn at the box origin
    expect(seg!.labelX).toBeCloseTo(6 + 3, 6); // past the icon edge (radius 6) + gap
  });

  it('places the label to the RIGHT of the icon (label x > icon x)', () => {
    const [seg] = layoutBadgeIconLabelRow({
      measures: [{ iconW: 12, labelW: 8 }],
      segGap: 4,
      iconLabelGap: 3,
    });
    expect(seg!.labelX).toBeGreaterThan(seg!.iconX);
  });

  it('lays out multiple segments left→right, centred, non-overlapping', () => {
    const measures: BadgeSegmentMeasure[] = [
      { iconW: 12, labelW: 8 },
      { iconW: 12, labelW: 14 },
      { iconW: 12, labelW: 8 },
    ];
    const placements = layoutBadgeIconLabelRow({ measures, segGap: 4, iconLabelGap: 3 });
    expect(placements).toHaveLength(3);
    // strictly increasing icon-centre x (left→right order preserved)
    expect(placements[0]!.x).toBeLessThan(placements[1]!.x);
    expect(placements[1]!.x).toBeLessThan(placements[2]!.x);
    // The icon is LEFT-justified in each segment (label trails to the right), so
    // icon centres are NOT mirror-symmetric — but the segment CENTRES are, when
    // the width sequence is palindromic. seg centre = icon centre + label-side
    // offset = x + (segW - iconW)/2.
    const segCentre = (i: number) =>
      placements[i]!.x + (badgeSegmentWidth(measures[i]!, 3) - measures[i]!.iconW) / 2;
    expect(segCentre(0)).toBeCloseTo(-segCentre(2), 6);
    expect(segCentre(1)).toBeCloseTo(0, 6);
  });

  it('handles an empty row', () => {
    expect(layoutBadgeIconLabelRow({ measures: [], segGap: 4, iconLabelGap: 3 })).toEqual([]);
  });
});
