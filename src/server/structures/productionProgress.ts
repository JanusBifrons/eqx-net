import { structureWorkRate } from '../../shared-types/structurePower.js';
import type { StructureRecord } from './StructureRegistry.js';

/** Advance a loaded cycle by one pulse at the owner throttle; true once it
 *  is complete (a hair of slack so tenths always add up to a whole cycle). */
export function advanceProgress(rec: StructureRecord, cyclePulses: number): boolean {
  const progress = rec.prodProgress ?? 0;
  if (progress < cyclePulses) rec.prodProgress = Math.min(cyclePulses, progress + structureWorkRate(rec));
  return (rec.prodProgress ?? 0) >= cyclePulses - 1e-6;
}
