/**
 * Base platforms — the player placement snap, both sides of the wire (#15).
 * On a deck room the client's placement ghost (`snapGhostToDeck`, called from
 * `routePlacementPointer` and `updatePlacementGhost`) and the server's
 * `place_structure` handler both run the core `snapPlacementToDeck`; the
 * structure must land exactly where the ghost was drawn. With the flag off,
 * neither side snaps. `place()` itself never snaps.
 * Slice 18: the snap also decides the turn (a small building faces its third
 * of the hex), so the placed `rot` must equal the ghost's drawn turn.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureMessages, type StructureMessageHost } from '../../src/server/rooms/features/structureMessages.js';
import { StructurePlacementSubsystem } from '../../src/server/structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { snapGhostToDeck } from '../../src/client/render/pixi/placementDeckSnap.js';
import { getStructureKind, isBuildableStructureKind } from '../../src/shared-types/structureKinds.js';
import { STRUCTURE_KINDS_LIST } from '../../src/shared-types/structureKinds/catalogueOrder.js';
import { deckHexCentreInto, isPlateCentreHex, plateCentreWorldInto } from '../../src/core/hex/plates.js';
import { rhombusCentroidInto } from '../../src/core/hex/deckSnap.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../src/core/structures/deckLinks.js';
import { DECK_PLATE_KIND, roadTurnDeg } from '../../src/core/structures/deckPlacement.js';

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
  /** Send place_structure; returns the placed record's centre + turn (or null). */
  const place = (kind: string, x: number, y: number, rot?: number): { x: number; y: number; rot: number } | null => {
    const before = registry.size;
    handlers.get('place_structure')!(client, { type: 'place_structure', kind, x, y, rot });
    if (registry.size === before) return null;
    const rec = registry.get(`pstruct-${n - 1}`)!;
    return { x: rec.x, y: rec.y, rot: rec.rot ?? 0 };
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

  it('small slot: the placed turn is the ghost rhombus facing, in all 3 rhombi, whatever the player turned', () => {
    let q = 2;
    while (isPlateCentreHex(q, 1)) q++; // a connector there lays a plate
    const hexC = deckHexCentreInto(q, 1, { x: 0, y: 0 });
    const p = { x: 0, y: 0 };
    const small = STRUCTURE_KINDS_LIST.filter((k) => k.deckSlot === 'small' && isBuildableStructureKind(k.id) && k.id !== DECK_FENCE_GATE_KIND && k.id !== DECK_FENCE_POST_KIND && k.id !== DECK_PLATE_KIND).map((k) => k.id);
    // Fence kinds snap to corners/edges (slice 19/21), the Deck plate kind
    // (connector) to the centre of the plate under it: not rhombi.
    expect(small.length).toBeGreaterThan(0);
    for (const kind of small) {
      expect(getStructureKind(kind).deckSlot).toBe('small');
      const seen = new Set<number>();
      for (let k = 0; k < 3; k++) {
        rhombusCentroidInto(hexC.x, hexC.y, k, p);
        for (const playerRot of [0, 90, 150]) {
          const r = rig(true);
          const ghost = snapGhostToDeck({ kind, x: 0, y: 0, angle: (playerRot * Math.PI) / 180, deck: true }, p.x + 9, p.y - 4);
          expect(ghost!.rhombus).toBe(k);
          const gx = ghost!.x, gy = ghost!.y, grot = ghost!.rot;
          const placed = r.place(kind, p.x + 9, p.y - 4, playerRot);
          expect(placed, `${kind} rhombus ${k}`).not.toBeNull();
          expect([placed!.x, placed!.y, placed!.rot]).toEqual([gx, gy, grot]);
          seen.add(grot);
        }
      }
      // Each rhombus has its own facing (the player's turn changes nothing).
      expect(seen.size, kind).toBe(3);
    }
  });

  it('road: the placed turn is the ghost turn, a 30° + 60°·k step whose carriageway runs edge-mid to edge-mid', () => {
    const hexC = deckHexCentreInto(2, 1, { x: 0, y: 0 });
    for (const playerRot of [0, 15, 29, 31, 60, 95, 150, 181, 240, 299, 330, 359]) {
      const r = rig(true);
      const ghost = snapGhostToDeck({ kind: 'road', x: 0, y: 0, angle: (playerRot * Math.PI) / 180, deck: true }, hexC.x + 40, hexC.y - 25);
      const gx = ghost!.x, gy = ghost!.y, grot = ghost!.rot;
      const placed = r.place('road', hexC.x + 40, hexC.y - 25, playerRot);
      expect(placed, `road at ${playerRot}`).not.toBeNull();
      expect([placed!.x, placed!.y, placed!.rot]).toEqual([gx, gy, grot]);
      expect([gx, gy]).toEqual([hexC.x, hexC.y]);
      expect(((grot % 60) + 60) % 60).toBe(30);
      expect(grot, `nearest step to ${playerRot}`).toBe(roadTurnDeg(playerRot));
      const off = Math.abs(((((playerRot - grot) % 360) + 540) % 360) - 180);
      expect(off).toBeLessThanOrEqual(30);
      // The carriageway (the tile's local y) points at game angle rot − 90°: an edge midpoint (60°·i).
      expect((((grot - 90) % 60) + 60) % 60).toBe(0);
    }
  });

  it('deck OFF: neither side snaps', () => {
    const r = rig(false);
    expect(snapGhostToDeck({ kind: 'connector', x: 0, y: 0, angle: 0, deck: false }, 137, -412)).toBeNull();
    expect(r.place('connector', 137, -412)).toEqual({ x: 137, y: -412, rot: 0 });
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
