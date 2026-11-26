/**
 * Ancients' gate "Astrolabe" art (teleporter redesign A2): the style C
 * drawer for `alien_gate` (light pool and
 * crystal, nothing in the ring band the under-layer rings turn in), the ring
 * art on the rig parts, and the rig's spin clock fed from the jump timetable
 * (`astrolabePoseAt`) instead of frame time, lanes in line at fire time.
 */
import { describe, expect, it } from 'vitest';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { buildStructureVisual } from './structureVisuals.js';
import { StructureRigView } from './structureRigs.js';
import { createRigClockMemo, type RigClockFrame } from './structureRigLook.js';
import { version } from './structureStyleC.transport.js';
import {
  ASTROLABE_GLOW_MAX, alienGate, astrolabeLitContext, astrolabePartContext, astrolabeSpinClock,
} from './structureStyleC.transport.astrolabe.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { alienGateSites } from '../../../core/galaxy/alienGates.js';
import { GALAXY_SECTORS } from '../../../core/galaxy/galaxy.js';
import { astrolabePoseAt, createAstrolabePose } from '../../../core/galaxy/alienGateAstrolabe.js';
import { ALIEN_GATE_INTERVAL_MS, alienGateOffsetMs, nextAlienGateJumpMs, TP_PHASE } from '../../../shared-types/teleport.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const SECTOR = GALAXY_SECTORS.find((s) => alienGateSites(s.key).length > 0)!.key;
const SITE = alienGateSites(SECTOR)[0]!;
const OFFSET = alienGateOffsetMs(SECTOR, SITE.neighbour);
const FIRE = nextAlienGateJumpMs(1_700_000_000_000, OFFSET);
const row = (phase: number): StructureRenderState =>
  ({ built: true, powered: true, buildPct: 1, deconstructPct: 0, connTo: [], teleport: { phase } }) as unknown as StructureRenderState;
const frame = (fxNowMs: number): RigClockFrame => ({ sectorKey: SECTOR, fxNowMs, hostX: SITE.x, hostY: SITE.y });
const target = (): { spinClock: number; litAlpha: number } => ({ spinClock: -1, litAlpha: -1 });

describe('astrolabe: style C alien_gate drawer', () => {
  it('is registered for alien_gate in style C, with the transport art version bumped', () => {
    expect(structureStyleDrawer('c', 'alien_gate')).toBe(alienGate);
    expect(version).toBe('t5c');
    expect(structureStyleVersion('c', 'alien_gate')).toBe('t5c');
  });

  it('bakes no pylons and nothing in the ring band', () => {
    const v = buildStructureVisual('alien_gate', { accent: 0x66ccaa, style: 'c', livery: true, powered: true });
    expect(v.polys.length).toBeGreaterThan(0);
    // Rings turn under the body sprite at 422..818 from the centre; the body
    // is only the light pool and crystal (no pylons), all inside the inner ring.
    for (const p of v.polys) for (const [px, py] of p.pts) expect(Math.hypot(px, py), `${px},${py}`).toBeLessThan(430);
  });
});

describe('astrolabe: ring rig art', () => {
  it('every ring part draws the stone art and carries a teal lit overlay', () => {
    const rig = rigForStructureKind('alien_gate')!;
    const view = new StructureRigView(rig);
    expect(view.hasSpin).toBe(true);
    expect(view.spinClockOf).toBe(astrolabeSpinClock);
    for (let i = 0; i < rig.partCount; i++) {
      const art = astrolabePartContext(rig, i);
      expect(art).not.toBeNull();
      expect(view.parts[i]!.context).toBe(art);
      expect(view.lit[i]).not.toBeNull();
      expect(view.lit[i]!.context).toBe(astrolabeLitContext(rig, i));
      // Cached: the same context every call.
      expect(astrolabePartContext(rig, i)).toBe(art);
    }
  });
});

describe('astrolabe: ring clock from the timetable', () => {
  it('drives the view clock from astrolabePoseAt, lanes aligned at fire time', () => {
    const memo = createRigClockMemo();
    memo.anchorMs = FIRE - 5000; // fxNow 5000 == the fire instant
    const t = target();
    expect(astrolabeSpinClock(row(TP_PHASE.IDLE), frame(5000), memo, t)).toBe(true);
    const p = astrolabePoseAt(createAstrolabePose(), FIRE, OFFSET, TP_PHASE.IDLE);
    expect(p.aligned).toBe(true);
    expect(t.spinClock).toBe(p.clockTicks);
    expect(t.litAlpha).toBeCloseTo(ASTROLABE_GLOW_MAX * p.settle);
    // Half a minute later the rings run free and the glow is out.
    astrolabeSpinClock(row(TP_PHASE.IDLE), frame(5000 + ALIEN_GATE_INTERVAL_MS / 2), memo, t);
    const q = astrolabePoseAt(createAstrolabePose(), FIRE + ALIEN_GATE_INTERVAL_MS / 2, OFFSET, TP_PHASE.IDLE);
    expect(t.spinClock).toBe(q.clockTicks);
    expect(t.litAlpha).toBe(0);
  });

  it('snaps a skewed anchor to the timetable when the gate leaves IDLE', () => {
    const memo = createRigClockMemo();
    memo.anchorMs = FIRE - 5000 + 7000; // client clock 7 s fast
    const t = target();
    astrolabeSpinClock(row(TP_PHASE.IDLE), frame(4000), memo, t);
    astrolabeSpinClock(row(TP_PHASE.ARMED), frame(5000), memo, t); // server says it fired now
    expect(memo.anchorMs).toBe(FIRE - 5000);
    const p = astrolabePoseAt(createAstrolabePose(), FIRE, OFFSET, TP_PHASE.ARMED);
    expect(t.spinClock).toBe(p.clockTicks);
  });

  it('runs free (frame clock) with no sector or no twin', () => {
    const t = target();
    expect(astrolabeSpinClock(row(0), { sectorKey: null, fxNowMs: 0, hostX: 0, hostY: 0 }, createRigClockMemo(), t)).toBe(false);
    expect(astrolabeSpinClock(row(0), { sectorKey: 'no-such-sector', fxNowMs: 0, hostX: 0, hostY: 0 }, createRigClockMemo(), t)).toBe(false);
    expect(t.spinClock).toBe(-1);
  });

  it('an external clock stops the view adding frame time, and lit overlays stay shown at the glow alpha', () => {
    const view = new StructureRigView(rigForStructureKind('alien_gate')!);
    view.setRunningFrom(row(TP_PHASE.IDLE));
    view.update(null, 0, 0, 0, 0);
    view.update(null, 50, 0, 0, 0);
    expect(view.spinClock).toBeCloseTo(50); // no hook call: frame time
    const memo = createRigClockMemo();
    memo.anchorMs = FIRE - 5000;
    view.externalClock = astrolabeSpinClock(row(TP_PHASE.IDLE), frame(5000), memo, view);
    expect(view.externalClock).toBe(true);
    const fed = view.spinClock;
    view.update(null, 90, 0, 0, 0);
    expect(view.spinClock).toBe(fed);
    for (const lit of view.lit) {
      if (lit === null) continue;
      expect(lit.visible).toBe(true);
      expect(lit.alpha).toBeCloseTo(ASTROLABE_GLOW_MAX);
    }
  });

  it('allocates no new state per call: same memo, same target, same pose source', () => {
    const memo = createRigClockMemo();
    memo.anchorMs = FIRE - 5000;
    const t = target();
    astrolabeSpinClock(row(0), frame(5000), memo, t);
    const keys = Object.keys(memo).join();
    for (let f = 0; f < 1000; f++) astrolabeSpinClock(row(f % 2 === 0 ? 0 : 1), frame(5000 + f * 16), memo, t);
    expect(Object.keys(memo).join()).toBe(keys);
    expect(memo.sector).toBe(SECTOR);
  });
});
