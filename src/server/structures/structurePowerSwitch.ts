/**
 * The owner's On/Off switch on a structure, beside the grid's active-power
 * switch (`StructureGridSubsystem.setActive`). Off ⇒ the structure draws
 * nothing (`structureDraw(…, switchedOff)`) and `powerSummaryFor` reads
 * unpowered to it, so turrets hold fire, shield walls drop and production,
 * labs and drills pause; On restores the idle draw and every subsystem picks
 * it back up on its next tick. Only a kind that draws power has an Off.
 * The same kinds take a power THROTTLE (0..100% in tenths): the draw scales.
 */
import { canSwitchStructure, normalizeStructureThrottle, structureDraw } from '../../shared-types/structurePower.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { StructureRecord } from './StructureRegistry.js';

/** Adjust a grid component's draw by `delta` (`Grid.adjustDraw`, O(1)). */
export type AdjustDraw = (id: string, delta: number) => void;

/** Move `rec` to a new (off, drawFull) draw state and adjust its grid
 *  component's net power by the difference (no rebuild). */
export function redrawStructure(rec: StructureRecord, off: boolean, drawFull: boolean, adjust: AdjustDraw): void {
  const cons = getStructureKind(rec.kind).powerConsumption;
  const before = structureDraw(cons, rec.drawFull === true, rec.switchedOff === true, rec.throttle);
  rec.drawFull = drawFull;
  if (rec.isConstructed) adjust(rec.id, structureDraw(cons, drawFull, off, rec.throttle) - before);
}

/** Set `rec`'s power throttle (tenths, 0..10; 10 = 100%) and adjust its grid
 *  component's draw by the difference (O(1)). False when its kind has no Off
 *  (the same set as the switch) or nothing changed. */
export function throttleStructure(rec: StructureRecord, tenths: number, adjust: AdjustDraw): boolean {
  const cons = getStructureKind(rec.kind).powerConsumption;
  if (!canSwitchStructure(cons)) return false;
  const next = normalizeStructureThrottle(tenths);
  if (next === rec.throttle) return false;
  const off = rec.switchedOff === true;
  const before = structureDraw(cons, rec.drawFull === true, off, rec.throttle);
  if (next === undefined) delete rec.throttle; else rec.throttle = next;
  if (rec.isConstructed) adjust(rec.id, structureDraw(cons, rec.drawFull === true, off, rec.throttle) - before);
  return true;
}

/** Switch `rec` On or Off. False when its kind has no Off or nothing changed. */
export function switchStructure(rec: StructureRecord, on: boolean, adjust: AdjustDraw): boolean {
  if (!canSwitchStructure(getStructureKind(rec.kind).powerConsumption)) return false;
  if ((rec.switchedOff !== true) === on) return false;
  redrawStructure(rec, !on, false, adjust);
  if (on) delete rec.switchedOff; else rec.switchedOff = true;
  return true;
}
