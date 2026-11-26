import { describe, expect, it } from 'vitest';
import { TeleportPadRiders, type TeleportRiderHost } from './teleportMessages.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';

/** Teleporter redesign T2: a chamber is sealed by its blast doors, so only the
 *  Ancients' gate keeps the iris walls. */
describe('iris spans', () => {
  const riders = new TeleportPadRiders({} as TeleportRiderHost);
  const spans = (kind: string): string[] => {
    const ids: string[] = [];
    riders.forIrisSpan({ id: 'p', kind, x: 0, y: 0 } as unknown as StructureRecord, (id) => ids.push(id));
    return ids;
  };
  it('the Ancients\' gate keeps its iris', () => {
    expect(spans('alien_gate').length).toBeGreaterThan(0);
  });
  it('the chamber pads have none', () => {
    for (const k of ['teleporter', 'teleporter_large', 'pocket_pad']) expect(spans(k)).toEqual([]);
  });
});
