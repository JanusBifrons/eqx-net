/**
 * Teleporter redesign T4 — the style C chamber (800 pads). The teleporter and
 * the transit pad draw the chamber from the T1 core geometry (towers, wall
 * boxes, door line), the blast doors wear the gatehouse leaf art, and the live
 * lights ride the body-status hook: floor lights by jump phase, coils by
 * banked charge, door strips by the decoded door segment.
 */
import { describe, expect, it } from 'vitest';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { padChamberWalls } from '../../../core/structures/padChamber.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS } from '../../../core/structures/gateGeometry.js';
import { PAD_SPECS, TP_PHASE, padPostCenters } from '../../../shared-types/teleport.js';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { artFramePx, insidePoly, polyBounds, polyEdgeDist } from './structureStyleKit.js';
import { StructureRigView } from './structureRigs.js';
import { bodyStatusCode, hasBodyStatus, socketNubContext } from './structureSocketNubs.js';
import { DECK_LIGHT_OPEN, DECK_LIGHT_SHUT, doorLeafContext } from './structureStyleC.fences.gate.js';
import { kinds, rigs, status, version } from './structureStyleC.transport.js';
import {
  AMBER_FLASH_TICKS, COIL_STEPS, TP_AMBER, TP_AMBER_OFF, chamber, chamberCode, chamberStatus, coilStep, phaseLightColor,
} from './structureStyleC.transport.chamber.js';

const PADS = ['teleporter', 'pocket_pad', 'teleporter_large'] as const;
const PHASES = [TP_PHASE.IDLE, TP_PHASE.ARMED, TP_PHASE.CLOSING, TP_PHASE.SEALED, TP_PHASE.OPEN] as const;

/** A built pad row at `phase` with `chargePct`, door fully open or shut. */
function row(phase: number, chargePct: number, powered = true, open = true): StructureRenderState {
  return {
    powered, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0,
    teleport: { phase, phaseMs: 0, chargePct, partner: -1, rules: 0, loadGood: 0, loadQty: 0, keepGood: 0, keepQty: 0, padWeight: 0, toll: 0 },
    doorA: { p0: open ? DOOR_POS_MAX : 0, t0: 0, dir: open ? 1 : -1, level: DOOR_POWER_LEVELS },
  } as unknown as StructureRenderState;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

describe('teleporter chamber art (T4)', () => {
  it('all three pads draw the chamber (Large from T5); the Ancients\' gate keeps its art; version bumped', () => {
    for (const id of PADS) {
      expect(kinds[id], id).toBe(chamber);
      expect(structureStyleDrawer('c', id), id).toBe(chamber);
      expect(structureStyleVersion('c', id), id).toBe(version);
      expect(status[id], id).toBe(chamberStatus);
      expect(hasBodyStatus(id), id).toBe(true);
    }
    expect(version).toBe('t5b');
    expect(rigs['tp-doors-large']?.partArt).toBe(rigs['tp-doors']?.partArt);
    expect(structureStyleDrawer('c', 'alien_gate')).toBeUndefined();
  });

  for (const id of PADS) {
    it(`${id}: a tower on every core tower box, a wall on every core wall box, all inside the frame`, () => {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true, powered: live });
        const bounds = v.polys!.map((p) => polyBounds(p.pts));
        const post = PAD_SPECS[id].post;
        for (const [x, y] of padPostCenters(id)) {
          const hit = bounds.some((b) => near(b.x, x - post / 2) && near(b.y, -y - post / 2) && near(b.w, post) && near(b.h, post));
          expect(hit, `${id} tower ${x},${y}`).toBe(true);
        }
        for (const w of padChamberWalls(id)) {
          const hit = bounds.some((b) => near(b.x, w.cx - w.hw) && near(b.y, -w.cy - w.hh) && near(b.w, 2 * w.hw) && near(b.h, 2 * w.hh));
          expect(hit, `${id} wall ${w.cx},${w.cy}`).toBe(true);
        }
        const frame = artFramePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(frame, x, y)).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(frame, l.x, l.y)).toBe(true);
        expect(v.polys!.some((p) => p.mat === 'hazard'), id).toBe(true);
        expect(v.bands!.length, id).toBeGreaterThan(0);
        expect(v.sigils!.length, id).toBe(2);
        expect(live ? v.lights.length > 0 : v.lights.length === 0, `${id} lamps ${live}`).toBe(true);
      }
    });
  }

  it('the blast doors wear the gatehouse leaf art', () => {
    expect(rigs['tp-doors']?.partArt).toBe(doorLeafContext);
    const rig = rigForStructureKind('teleporter')!;
    expect(rig.id).toBe('tp-doors');
    const view = new StructureRigView(rig);
    expect(view.parts.length).toBe(4);
    view.parts.forEach((g, i) => {
      const ctx = doorLeafContext(rig, i);
      expect(ctx).not.toBeNull();
      expect(g.context).toBe(ctx);
    });
  });

  it('floor lights by phase: green idle / open, amber (flashing) armed / closing, red sealed', () => {
    expect(phaseLightColor(TP_PHASE.IDLE, false)).toBe(DECK_LIGHT_OPEN);
    expect(phaseLightColor(TP_PHASE.OPEN, false)).toBe(DECK_LIGHT_OPEN);
    expect(phaseLightColor(TP_PHASE.ARMED, false)).toBe(TP_AMBER);
    expect(phaseLightColor(TP_PHASE.CLOSING, true)).toBe(TP_AMBER_OFF);
    expect(phaseLightColor(TP_PHASE.SEALED, false)).toBe(DECK_LIGHT_SHUT);
    // Armed flashes with the rig clock; idle never does.
    const armed = row(TP_PHASE.ARMED, 100);
    expect(chamberCode('teleporter', armed, 0)).not.toBe(chamberCode('teleporter', armed, AMBER_FLASH_TICKS));
    const idle = row(TP_PHASE.IDLE, 100);
    expect(chamberCode('teleporter', idle, 0)).toBe(chamberCode('teleporter', idle, AMBER_FLASH_TICKS));
  });

  it('a distinct code per phase, charge step and door state; each draws without throwing', () => {
    for (const id of PADS) {
      const seen = new Set<number>();
      for (const p of PHASES) {
        for (const pct of [0, 50, 100]) {
          for (const open of [true, false]) {
            const code = chamberCode(id, row(p, pct, true, open), 0);
            expect(code, `${id} ${p} ${pct} ${open}`).toBeGreaterThan(0);
            expect(seen.has(code)).toBe(false);
            seen.add(code);
            expect(bodyStatusCode(id, row(p, pct, true, open), 0)).toBe(code);
            expect(() => socketNubContext(id, 0, code)).not.toThrow();
          }
        }
      }
    }
  });

  it('coils fill with the banked charge: full only at 100 %', () => {
    expect(coilStep(0)).toBe(0);
    expect(coilStep(99)).toBe(COIL_STEPS - 1);
    expect(coilStep(100)).toBe(COIL_STEPS);
    expect(coilStep(250)).toBe(COIL_STEPS);
    const at = (pct: number): number => chamberCode('teleporter', row(TP_PHASE.IDLE, pct), 0);
    expect(at(0)).not.toBe(at(100));
  });

  it('no power: a teleporter goes dark (charge still shown); the free transit pad stays lit; unbuilt shows the bake', () => {
    const dark = chamberCode('teleporter', row(TP_PHASE.IDLE, 50, false), 0);
    expect(dark).toBe(1 + coilStep(50));
    expect(chamberCode('teleporter', row(TP_PHASE.SEALED, 50, false), 0)).toBe(dark);
    expect(chamberCode('pocket_pad', row(TP_PHASE.IDLE, 50, false), 0)).toBe(chamberCode('pocket_pad', row(TP_PHASE.IDLE, 50, true), 0));
    expect(() => socketNubContext('teleporter', 0, dark)).not.toThrow();
    const unbuilt = row(TP_PHASE.IDLE, 0);
    unbuilt.built = false;
    expect(chamberCode('teleporter', unbuilt, 0)).toBe(0);
    expect(chamberCode('teleporter', undefined, 0)).toBe(0);
  });
});
