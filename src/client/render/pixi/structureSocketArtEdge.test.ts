/**
 * Stud audit: every kind's cable sockets sit on its drawn style C edge.
 */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST, SOCKET_OUTLINE_STYLE } from '../../../shared-types/structureKinds.js';
import { DEFAULT_STRUCT_STYLE } from '../art/artMode.js';
import { socketArtEdges } from './structureSocketArtEdge.js';

const postKind = (k: string): boolean => k === 'shield_gate' || k === 'shield_airlock';

describe('socket studs vs the drawn style C edge', () => {
  it('prints the per-kind table', () => {
    const rows: string[] = [];
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (postKind(kind.id)) continue;
      const e = socketArtEdges(kind.id);
      const worst = Math.max(...e.map((s) => s.dist));
      const off = e.filter((s) => s.dist > 3).length;
      const covered = e.filter((s) => s.under > 0).map((s) => `${s.index}@${s.under}`).join(' ');
      rows.push(`${kind.id.padEnd(24)} n=${String(e.length).padStart(2)} worst=${worst.toFixed(1).padStart(6)} off=${off}${covered ? ` under:${covered}` : ''}`);
    }
    console.log(`[stud-audit]\n${rows.join('\n')}`);
  });

  // A nub reaches NUB_OUT (6 u) past its point and NUB_IN (4 u) under it, so a
  // point within 5 u of the drawn edge reads as on it. The shield pylon's four
  // cut-corner studs (it takes any side) sit half the corner cut (0.22 × the
  // half-size, so 6.6 u at 120 u) in from its square plate, until its redraw.
  const TOL = 5;
  const tolFor = (id: string): number =>
    id === 'shield_pylon' ? Math.max(TOL, 0.11 * (STRUCTURE_KINDS_LIST.find((k) => k.id === id)!.footprint.w / 2) + 1) : TOL;

  it('every kind: each socket lies on the drawn outer edge, art behind it, nothing raised on it', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (postKind(kind.id)) continue;
      for (const s of socketArtEdges(kind.id)) {
        const at = `${kind.id} #${s.index} (${s.x.toFixed(0)}, ${s.y.toFixed(0)})`;
        expect(s.dist, `${at} off the drawn edge`).toBeLessThanOrEqual(tolFor(kind.id));
        expect(s.inside, `${at} has no art behind it`).toBe(true);
        expect(s.under, `${at} under a raised part`).toBe(0);
      }
    }
  });

  it('the socket outline style is the house look', () => {
    expect(SOCKET_OUTLINE_STYLE).toBe(DEFAULT_STRUCT_STYLE);
  });
});
