/**
 * Base platforms — the `off-deck` rule, both sides of the wire (#15). The
 * server's `place_structure` (deck room: snap, then `place(..., { deck })`)
 * and the client ghost (`writePreviewDeck` copies the local player's plates
 * from the client's `PlateSet` onto the preview; the renderer's
 * `ghostDeckContext` + `PlacementGhostVerdict` run `placementRejection` on it)
 * must give the same verdict for the same inputs.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from '../../src/server/rooms/features/structureMessages.js';
import { StructurePlacementSubsystem } from '../../src/server/structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { ghostDeckContext, snapGhostToDeck } from '../../src/client/render/pixi/placementDeckSnap.js';
import { PlacementGhostVerdict } from '../../src/client/structures/placementGhostVerdict.js';
import { writePreviewDeck, type PlacementPreview } from '../../src/client/structures/structurePlacementClient.js';
import { PlateSet } from '../../src/core/hex/plateSet.js';
import { deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../../src/core/hex/plates.js';
import { placementRejectionNotice } from '../../src/core/structures/placementRules.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import type { StructureKindId } from '../../src/shared-types/structureKinds.js';

const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });
const ringHex = (i: number, j: number, k: number): { x: number; y: number } => {
  const h = plateHexes(i, j)[k]!;
  return deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
};

/** A deck room: player-1 owns plate (0,0), rival owns plate (4,0), both as
 *  real connectors (system placements, no deck rule). */
function rig() {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true, seedHealth: () => {}, despawn: () => {}, clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`, registry, getObstacles: () => [],
  });
  const a = centre(0, 0), b = centre(4, 0);
  expect(placement.place('player-1', 'connector', a.x, a.y)).not.toBeNull();
  expect(placement.place('rival', 'connector', b.x, b.y)).not.toBeNull();
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const host = {
    onMessage: (type: string, h: (client: Client, raw: unknown) => void) => { handlers.set(type, h); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'player-1']]),
    structureRegistry: registry,
    structurePlacement: () => placement,
    testSeedStorageHold: () => null,
    deck: () => true,
    rebuildStructuresSlice: () => {},
    sectorPersistence: () => ({ persistSoon: () => {} }),
    sectorKey: () => null,
    findPacked: () => null,
    sendNotice: () => {},
    logger: { warn: () => {} },
  } as unknown as StructureMessageHost;
  registerStructureMessages(host);
  const client = { sessionId: 's1' } as Client;
  /** The server's verdict: null = placed, else the refusal notice. */
  const serverVerdict = (kind: string, x: number, y: number): string | null => {
    const before = registry.size;
    handlers.get('place_structure')!(client, { type: 'place_structure', kind, x, y });
    return registry.size > before ? null : placement.lastRefusal;
  };
  /** The server's verdict for an exact (unsnapped) player placement on the deck. */
  const serverExact = (kind: string, x: number, y: number): string | null =>
    placement.place('player-1', kind, x, y, { deck: true }) !== null ? null : placement.lastRefusal;

  // The client mirror of the same room: its plate set (StructureRowSync's) and
  // the render mirror's structures / swarm poses.
  const clientPlates = new PlateSet<number>();
  const structures = new Map<number, StructureRenderState>();
  const swarm = new Map<number, SwarmRenderState>();
  let e = 1;
  for (const rec of registry.all()) {
    clientPlates.upsert(e, rec.owner, rec.kind, rec.x, rec.y);
    structures.set(e, { mirror: false } as StructureRenderState);
    swarm.set(e, { x: rec.x, y: rec.y, angle: 0, shipKind: rec.kind } as SwarmRenderState);
    e++;
  }
  const verdict = new PlacementGhostVerdict();
  /** The ghost's verdict at the same requested point, as the notice. */
  const ghostVerdict = (kind: string, x: number, y: number, snapIt = true): string | null => {
    const preview: PlacementPreview = { kind: kind as StructureKindId, x: 0, y: 0, angle: 0 };
    writePreviewDeck(preview, true, clientPlates, 'player-1');
    const snap = snapIt ? snapGhostToDeck(preview, x, y)! : { x, y };
    const r = verdict.check({ kind, x: snap.x, y: snap.y, angle: 0 }, structures, swarm, null, ghostDeckContext(preview));
    return r === null ? null : placementRejectionNotice(r);
  };
  return { serverVerdict, serverExact, ghostVerdict };
}

const off = placementRejectionNotice('off-deck');

const CASES: Array<[string, string, { x: number; y: number }, string | null]> = [
  ['on own plate', 'reactor', ringHex(0, 0, 2), null],
  ['on own plate (solar)', 'solar', ringHex(0, 0, 4), null],
  ['off every plate', 'reactor', centre(9, -7), off],
  ['non-connector on an adjacent plate centre', 'reactor', centre(0, 1), off],
  ["on another owner's plate", 'reactor', ringHex(4, 0, 3), off],
];

describe('off-deck parity (client ghost verdict == server place_structure)', () => {
  for (const [name, kind, p, want] of CASES) {
    it(name, () => {
      const { serverVerdict, ghostVerdict } = rig();
      const ghost = ghostVerdict(kind, p.x, p.y);
      expect(ghost).toBe(want);
      expect(serverVerdict(kind, p.x, p.y)).toBe(ghost);
    });
  }

  // A connector on a plate centre: the player snap puts a connector on a
  // small slot, never a plate centre (laying a plate through the player path
  // is slice 8), so these compare the exact point: server place(deck) vs ghost.
  const EXACT: Array<[string, string, { x: number; y: number }, string | null]> = [
    ['new plate: connector on an adjacent plate centre', 'connector', centre(1, 0), null],
    ['new plate: connector on a far plate centre', 'connector', centre(2, 2), off],
    ['own occupied plate centre', 'connector', centre(0, 0), placementRejectionNotice('overlap-structure')],
    ['off every plate', 'reactor', centre(9, -7), off],
  ];
  for (const [name, kind, p, want] of EXACT) {
    it(`exact point: ${name}`, () => {
      const { serverExact, ghostVerdict } = rig();
      const ghost = ghostVerdict(kind, p.x, p.y, false);
      expect(ghost).toBe(want);
      expect(serverExact(kind, p.x, p.y)).toBe(ghost);
    });
  }

  it('deck off: the preview carries no deck context', () => {
    const preview: PlacementPreview = { kind: 'reactor', x: 0, y: 0, angle: 0 };
    writePreviewDeck(preview, false, new PlateSet<number>(), 'player-1');
    expect(ghostDeckContext(preview)).toBeNull();
  });
});
