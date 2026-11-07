/**
 * The showcase wobble gate (review 2026-11-07): a take whose local ship jumps
 * on screen (prediction corrections) is flagged, a steady one passes, and a
 * shot with no local ship in view is not scored. Calibrated on real takes:
 * capital-guns-fighter measured 0.88 px/frame in its jittery window, a good
 * round-2 take 0.10-0.16.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { wobbleFromCsv, wobbleProblem } from '../../showcase/wobble';

const HEAD = 'f,t,dt,shipX,shipY,sdx,sdy,bgdx,bgdy,bgN,bgSpread,greenN';
function csv(n: number, sdx: (i: number) => number, green = 40): string {
  const rows = [HEAD];
  for (let i = 0; i < n; i++) rows.push([i, (i * 1000) / 60, 16.7, 960, 540, sdx(i).toFixed(3), '0', '0', '0', 20, 0, green].join(','));
  return rows.join('\n');
}

describe('showcase wobble gate', () => {
  it('a steady ship passes', () => {
    const w = wobbleFromCsv(csv(600, () => 0.02));
    expect(w.p99Px).toBeLessThan(0.05);
    expect(wobbleProblem(w)).toBeNull();
  });

  it('a ship jumping back and forth for a second is flagged', () => {
    const w = wobbleFromCsv(csv(600, (i) => (i > 300 && i < 360 ? (i % 2 ? 4 : -4) : 0)));
    expect(w.spikes).toBeGreaterThan(5);
    expect(wobbleProblem(w)).toMatch(/ship jitter/);
    expect(w.firstSpikeMs).toBeGreaterThan(4000);
  });

  it('a smooth glide (camera easing) is not jitter', () => {
    const w = wobbleFromCsv(csv(600, (i) => Math.sin(i / 60) * 3));
    expect(wobbleProblem(w)).toBeNull();
  });

  it('no local ship in view: not scored', () => {
    expect(wobbleProblem(wobbleFromCsv(csv(600, (i) => (i % 2 ? 2 : -2), 0)))).toBeNull();
  });

  it('the reference good take passes (when present)', () => {
    const f = 'diag/_clip-jitter/good-round2.csv';
    if (!existsSync(f)) return;
    expect(wobbleProblem(wobbleFromCsv(readFileSync(f, 'utf8')))).toBeNull();
  });
});
