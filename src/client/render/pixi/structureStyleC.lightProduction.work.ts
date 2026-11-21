/**
 * Light production's shared "lit only while it works" look (structure
 * restyle, family lightProduction; owner 2026-11-20). Every kind in the family
 * bakes its work-glow glass DARK (`SLIT_DEAD`, `bakeSlits`) and lights it on the
 * live socket-nub overlay (`BodyStatusHook`, structureSocketNubs.ts) from the
 * row's `prodState` (`PROD_STATE`): lit while running, a red no-supply mark
 * (`drawNoSupplyMark`, the reactor's) while starved, dark otherwise.
 * A kind's drawer and its slit / mark positions live in its own file; this
 * file is the one place the code and the glow are drawn (`workGlowStatus`).
 */
import type { GraphicsContext } from 'pixi.js';
import { LAMP_AMBER, LAMP_WHITE, chamferBox, glow, type StyleCtx } from './structureStyleKit.js';
import type { BodyStatusHook } from './structureSocketNubs.js';
import { drawNoSupplyMark } from './structureStyleC.power.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import { PROD_STATE } from '../../../shared-types/production.js';

/** A work-glow pane: x, y, w, h in px, the drawer's frame. */
export type WorkSlit = readonly [number, number, number, number];
/** Where a starved kind's red no-supply mark sits: x, y, half height, stroke width (px). */
export type WorkMark = readonly [number, number, number, number];

/** Unlit work-glow glass: a dark, faintly amber pane. */
export const SLIT_DEAD = 0x2a1c12;

/** Status codes: 0 dark (idle, blocked, unbuilt or unpowered), 1 working
 *  (panes lit), 2 starved (dark, red no-supply mark). */
export const WORK_DARK = 0;
export const WORK_ON = 1;
export const WORK_STARVED = 2;

/** The status code for a row, from its `prodState`. */
export function workCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  if (st === undefined || !st.built || !st.powered) return WORK_DARK;
  if (st.prodState === PROD_STATE.running) return WORK_ON;
  if (st.prodState === PROD_STATE.starved) return WORK_STARVED;
  return WORK_DARK;
}

/** Bake a kind's panes dark (call from its drawer). */
export function bakeSlits(c: StyleCtx, slits: ReadonlyArray<WorkSlit>): void {
  for (const [x, y, w, h] of slits) glow(c, chamferBox(x, y, w, h, 1.5), SLIT_DEAD, 0.9);
}

const _fill = { color: 0, alpha: 0 };

/** Working: each pane lit amber with a soft halo and a hot white core line.
 *  Starved: the red no-supply mark. Allocates nothing per call. */
export function drawWorkGlow(g: GraphicsContext, code: number, slits: ReadonlyArray<WorkSlit>, mark: WorkMark): void {
  if (code === WORK_ON) {
    for (const [x, y, w, h] of slits) {
      g.roundRect(x - 3, y - 3, w + 6, h + 6, 3); _fill.color = LAMP_AMBER; _fill.alpha = 0.22; g.fill(_fill);
      g.roundRect(x, y, w, h, 1.5); _fill.color = LAMP_AMBER; _fill.alpha = 0.95; g.fill(_fill);
      const vertical = h > w;
      if (vertical) g.rect(x + w / 2 - 0.6, y + 2, 1.2, h - 4);
      else g.rect(x + 2, y + h / 2 - 0.6, w - 4, 1.2);
      _fill.color = LAMP_WHITE; _fill.alpha = 0.85; g.fill(_fill);
    }
  } else if (code === WORK_STARVED) {
    drawNoSupplyMark(g, mark[0], mark[1], mark[2], mark[3]);
  }
}

/** A kind's status hook: its panes and mark, drawn by `drawWorkGlow`. Built
 *  once at module load (one closure per kind), never per frame. */
export function workGlowStatus(slits: ReadonlyArray<WorkSlit>, mark: WorkMark): BodyStatusHook {
  return { code: workCode, draw: (g, code) => drawWorkGlow(g, code, slits, mark) };
}
