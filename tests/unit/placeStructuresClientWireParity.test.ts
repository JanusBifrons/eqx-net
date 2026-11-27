/**
 * Client → server wire parity (#15) for plan then Build: the exact payload
 * `sendPlaceStructures` puts on the wire (the planned list, deck-snapped or
 * not) must pass the strict server `PlaceStructuresSchema`, and the server's
 * refusal reply must pass the client's ingest schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../src/client/net/clientSingleton.js', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload: structuredClone(payload) }) }) }),
}));

import { sendPlaceStructures } from '../../src/client/structures/structurePlacementClient';
import { addPlannedPlacement, clearPlacementPlan, plannedPlacements } from '../../src/client/structures/placementPlan';
import {
  PLACE_STRUCTURES_MAX, PlaceStructuresRefusedSchema, PlaceStructuresSchema, ServerMessageSchemas,
} from '../../src/shared-types/messages';

describe('place_structures sender matches the server schema', () => {
  afterEach(() => { sent.length = 0; clearPlacementPlan(); });

  it('a mixed plan (open space and deck, turned, mirrored)', () => {
    addPlannedPlacement('solar', 100, -50, 90, false, false);
    addPlannedPlacement('battery', 3000, 0, 0, true, false);
    addPlannedPlacement('connector', 40.5, 12.25, 30, false, true);
    expect(sendPlaceStructures(plannedPlacements())).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('place_structures');
    const r = PlaceStructuresSchema.safeParse(sent[0]!.payload);
    expect(r.success, JSON.stringify(sent[0]!.payload)).toBe(true);
    expect(r.data!.items.length).toBe(3);
  });

  it('a full plan (PLACE_STRUCTURES_MAX) still passes; the plan takes no more', () => {
    for (let i = 0; i < PLACE_STRUCTURES_MAX; i++) expect(addPlannedPlacement('solar', i * 1000, 0, 0, false, false)).toBe(true);
    expect(addPlannedPlacement('solar', -1000, 0, 0, false, false)).toBe(false);
    sendPlaceStructures(plannedPlacements());
    expect(PlaceStructuresSchema.safeParse(sent[0]!.payload).success).toBe(true);
  });

  it('an empty plan sends nothing', () => {
    expect(sendPlaceStructures(plannedPlacements())).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('the server refusal reply passes the client ingest schema', () => {
    const reply = { type: 'place_structures_refused', refused: [{ index: 0, code: 'overlap-structure' }, { index: 3, code: 'no-crate' }] };
    expect(PlaceStructuresRefusedSchema.safeParse(reply).success).toBe(true);
    expect(ServerMessageSchemas.place_structures_refused.safeParse(reply).success).toBe(true);
    expect(PlaceStructuresRefusedSchema.safeParse({ ...reply, refused: [{ index: 0, code: 'nope' }] }).success).toBe(false);
  });
});
