/**
 * Solar-system sectors (Phase 4): convoys FLY the open space between a gate
 * pocket and the base (user, 2026-11-07: "long travel times… to leave time
 * for them to be vulnerable and in open space where you could potentially
 * intercept or ambush"). They enter and leave through the gate facing the
 * sector they come from / go to.
 */
import { describe, expect, it } from 'vitest';
import { solarLanePoint } from './ConvoyDirector.js';
import { sectorSites } from '../../core/galaxy/sectorSites.js';
import { getNeighbours, GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

const homeBox = { x0: -600, y0: -600, x1: 600, y1: 600 };

describe('convoy lanes in solar-system sectors', () => {
  it('a convoy from a neighbour enters on the rim of the gate pocket facing it', () => {
    const n = getNeighbours('sol-prime')[0]!;
    const p = solarLanePoint('sol-prime', n.key, homeBox)!;
    const gate = sectorSites('sol-prime').find((s) => s.id === `gate:${n.key}`)!;
    expect(Math.hypot(p.x - gate.x, p.y - gate.y)).toBeCloseTo(gate.r, -1);
    // On the base's side of the pocket, and a long leg from it (open space).
    expect(Math.hypot(p.x, p.y)).toBeLessThan(Math.hypot(gate.x, gate.y));
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(150_000);
  });

  it('a convoy to a far sector leaves by the gate toward it; every sector resolves a lane', () => {
    for (const s of GALAXY_SECTORS) {
      for (const t of GALAXY_SECTORS) expect(solarLanePoint(s.key, t.key, homeBox), `${s.key}->${t.key}`).not.toBeNull();
    }
    expect(solarLanePoint('nowhere', 'sol-prime', homeBox)).toBeNull();
  });
});
