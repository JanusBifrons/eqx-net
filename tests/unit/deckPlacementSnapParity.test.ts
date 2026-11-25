/**
 * Base platforms — the player placement snap, both sides of the wire (#15).
 * On a deck room the client's placement ghost (`snapGhostToDeck`, called from
 * `routePlacementPointer` and `updatePlacementGhost`) and the server's
 * `place_structure` handler both run the core `snapPlacementToDeck`; the
 * structure must land exactly where the ghost was drawn. With the flag off,
 * neither side snaps. `place()` itself never snaps.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from '../../src/server/rooms/features/structureMessages.js';
import { StructurePlacementSubsystem } from '../../src/server/structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { snapGhostToDeck } from '../../src/client/render/pixi/placementDeckSnap.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import { plateCentreWorldInto } from '../../src/core/hex/plates.js';

function rig(deck: boolean) {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true, seedHealth: () => {}, despawn: () => {}, clamp: (x, y) => ({ x, y }),
    nextId: () => `pstruct-${n++}`, registry, getObstacles: () => [],
  });
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const host = {
    onMessage: (type: string, h: (client: Client, raw: unknown) => void) => { handlers.set(type, h); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'player-1']]),
    structureRegistry: registry,
    structurePlacement: () => placement,
    testSeedStorageHold: () => null,
    deck: () => deck,
    rebuildStructuresSlice: () => {},
    sectorPersistence: () => ({ persistSoon: () => {} }),
    sectorKey: () => null,
    findPacked: () => null,
    sendNotice: () => {},
    logger: { warn: () => {} },
  } as unknown as StructureMessageHost;
  registerStructureMessages(host);
  // The off-deck rule needs player-1 to have deck under every test point:
  // seed plates (derived-set anchors only, no structures to overlap).
  if (deck) {
    const c = { x: 0, y: 0 };
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
      plateCentreWorldInto(i, j, c);
      registry.plates.upsert(`seed-${i},${j}`, 'player-1', 'connector', c.x, c.y);
    }
  }
  const client = { sessionId: 's1' } as Client;
  /** Send place_structure; returns the placed record's centre (or null). */
  const place = (kind: string, x: number, y: number): { x: number; y: number } | null => {
    const before = registry.size;
    handlers.get('place_structure')!(client, { type: 'place_structure', kind, x, y });
    if (registry.size === before) return null;
    const rec = registry.get(`pstruct-${n - 1}`)!;
    return { x: rec.x, y: rec.y };
  };
  return { place, placement, registry };
}

/** One kind per slot size the player can build. */
const KINDS = ['connector', 'reactor', 'teleporter_large'] as const;
const POINTS: Array<[number, number]> = [[0, 0], [137, -412], [-905, 333], [2210, 1777], [-3100, -2600], [640, 4020]];

describe('deck placement snap parity (client ghost == server placed point)', () => {
  it('covers small, hex and plate slots', () => {
    expect(getStructureKind('connector').deckSlot).toBe('small');
    expect(getStructureKind('reactor').deckSlot).toBe('hex');
    expect(getStructureKind('teleporter_large').deckSlot).toBe('plate');
  });

  for (const kind of KINDS) {
    it(`${kind}: deck ON places exactly at the ghost's snapped point`, () => {
      for (const [x, y] of POINTS) {
        const r = rig(true);
        const ghost = snapGhostToDeck({ kind, x: 0, y: 0, angle: 0, deck: true }, x, y);
        expect(ghost).not.toBeNull();
        const gx = ghost!.x, gy = ghost!.y;
        const placed = r.place(kind, x, y);
        expect(placed, `${kind} at ${x},${y}`).not.toBeNull();
        expect(placed!.x).toBe(gx);
        expect(placed!.y).toBe(gy);
      }
    });
  }

  it('deck OFF: neither side snaps', () => {
    const r = rig(false);
    expect(snapGhostToDeck({ kind: 'connector', x: 0, y: 0, angle: 0, deck: false }, 137, -412)).toBeNull();
    expect(r.place('connector', 137, -412)).toEqual({ x: 137, y: -412 });
  });

  it('the pending (sent) ghost is never re-snapped', () => {
    expect(snapGhostToDeck({ kind: 'connector', x: 0, y: 0, angle: 0, deck: true, pending: true }, 137, -412)).toBeNull();
  });

  it('place() itself never snaps (NPC seeding, restore, scenarios)', () => {
    const r = rig(true);
    const id = r.placement.place('player-1', 'connector', 137, -412);
    const rec = r.registry.get(id!)!;
    expect([rec.x, rec.y]).toEqual([137, -412]);
  });
});
