/**
 * Base platforms slice 27 — `?room=deck-bases`: the room's two NPC base specs
 * (sparse + dense, same tier/role/seed) seed cleanly on a deck through the
 * real placement seam, the dense one on fewer plates, and their decks keep
 * apart; each base's gate roads are all on one road network (owner: "Join
 * every gate").
 */
import { describe, expect, it } from 'vitest';
import { npcOwner } from '../../../shared-types/relations.js';
import { StructureRegistry } from '../../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../../structures/StructurePlacementSubsystem.js';
import { NpcBaseSubsystem } from '../../bases/NpcBaseSubsystem.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { connectorOnRoadHex, DECK_ROAD_KIND, isRoadBesideDeckGate } from '../../../core/structures/deckGateRoad.js';
import { HEX_DIRS, pixelToAxialInto } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { isConnectorKind, structureHalfExtents } from '../../../shared-types/structureKinds.js';
import { DECK_BASES_DENSE_AT, DECK_BASES_DENSE_EXT, DECK_BASES_GAP, DECK_BASES_OPTS, DECK_BASES_SPARSE_AT, DECK_BASES_SPARSE_EXT, DECK_BASES_SPECS } from './deckBasesRoom.js';

function seedRoomBases() {
  const registry = new StructureRegistry();
  registry.deck = DECK_BASES_OPTS.deck;
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: () => undefined,
    despawn: () => undefined,
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    structureUid: (_o, kind, x, y) => `uid-${kind}-${x}-${y}`,
    registry,
  });
  const sub = new NpcBaseSubsystem({
    registry,
    place: (owner, kind, x, y, rot) => placement.place(owner, kind, x, y, { skipAutoConnect: true, rot }),
    setHealth: () => undefined,
  });
  return { registry, seeded: DECK_BASES_SPECS.map((s) => sub.seed(s)) };
}


/** On the owner's deck: the centre on a plate, or (a fence post/gate on a
 *  seam, as the placement rule allows) a point 2 u around it on one. */
function onOwnDeck(registry: StructureRegistry, owner: string, kind: string, x: number, y: number): boolean {
  if (registry.plates.plateAtWorld(owner, x, y)) return true;
  if (kind !== DECK_FENCE_POST_KIND && kind !== DECK_FENCE_GATE_KIND) return false;
  for (let k = 0; k < 12; k++) if (registry.plates.plateAtWorld(owner, x + 2 * Math.cos(k * Math.PI / 6), y + 2 * Math.sin(k * Math.PI / 6))) return true;
  return false;
}

const hexKey = (x: number, y: number): string => {
  const h = pixelToAxialInto(x, y, DECK_HEX_SIZE, { q: 0, r: 0 });
  return `${h.q},${h.r}`;
};

describe('deck-bases test room (base platforms 27)', () => {
  it('seeds both bases on the deck with no rejected placement or edge, dense on fewer plates, decks apart', () => {
    const { registry, seeded } = seedRoomBases();
    const [sparse, dense] = seeded;
    for (const r of seeded) {
      expect(r.rejectedPlace, r.owner).toBe(0);
      expect(r.rejectedEdge, r.owner).toBe(0);
    }
    const sOwner = npcOwner('traders', 'sparse'), dOwner = npcOwner('traders', 'dense');
    expect(sparse!.owner).toBe(sOwner);
    expect(dense!.owner).toBe(dOwner);
    const sPlates = registry.plates.plateCount(sOwner), dPlates = registry.plates.plateCount(dOwner);
    expect(dPlates).toBeGreaterThan(0);
    expect(dPlates).toBeLessThan(sPlates);
    // Every piece stands on its own deck, never on the other base's.
    for (const rec of registry.all()) {
      const other = rec.owner === sOwner ? dOwner : sOwner;
      expect(onOwnDeck(registry, rec.owner, rec.kind, rec.x, rec.y), `${rec.kind} on its plate`).toBe(true);
      expect(registry.plates.plateAtWorld(other, rec.x, rec.y), `${rec.kind} off the other deck`).toBe(false);
    }
    // Roads can't go through a connector: no connector reaches into a road's hex.
    const all = [...registry.all()];
    const roads = all.filter((r) => r.kind === DECK_ROAD_KIND);
    expect(roads.length).toBeGreaterThan(0);
    for (const c of all) {
      if (!isConnectorKind(c.kind)) continue;
      const e = structureHalfExtents(c.kind, 0);
      for (const r of roads) expect(connectorOnRoadHex(c.x, c.y, e.hw, e.hh, r.x, r.y), `${c.kind} ${c.id} in road ${r.id}'s hex`).toBe(false);
    }
    // Every gate's road is on one road network, per base (no lone stub).
    for (const owner of [sOwner, dOwner]) {
      const mine = all.filter((r) => r.owner === owner);
      const roadHexes = new Set(mine.filter((r) => r.kind === DECK_ROAD_KIND).map((r) => hexKey(r.x, r.y)));
      const gates = mine.filter((g) => g.kind === DECK_FENCE_GATE_KIND);
      expect(gates.length, `${owner} gates`).toBeGreaterThanOrEqual(2);
      const gateRoads = gates.map((g) => {
        const r = mine.find((p) => isRoadBesideDeckGate(p.kind, p.x, p.y, g.x, g.y, g.rot ?? 0));
        expect(r, `${owner} gate ${g.id} has its road`).toBeDefined();
        return hexKey(r!.x, r!.y);
      });
      const seen = new Set([gateRoads[0]!]);
      for (const open = [gateRoads[0]!]; open.length > 0;) {
        const [q, r] = open.pop()!.split(',').map(Number) as [number, number];
        for (const d of HEX_DIRS) {
          const k = `${q + d.q},${r + d.r}`;
          if (roadHexes.has(k) && !seen.has(k)) { seen.add(k); open.push(k); }
        }
      }
      for (const k of gateRoads) expect(seen.has(k), `${owner}: gate road ${k} joined to the network`).toBe(true);
    }
    // Whole-deck extents (every plate's 7 hexes) keep the gap.
    expect(DECK_BASES_DENSE_AT.x + DECK_BASES_DENSE_EXT.x0 - (DECK_BASES_SPARSE_AT.x + DECK_BASES_SPARSE_EXT.x1)).toBeGreaterThanOrEqual(DECK_BASES_GAP);
    // The pilot spawns in the gap, on neither deck.
    const sx = DECK_BASES_OPTS.defaultSpawnX;
    expect(sx).toBeGreaterThan(DECK_BASES_SPARSE_AT.x + DECK_BASES_SPARSE_EXT.x1);
    expect(sx).toBeLessThan(DECK_BASES_DENSE_AT.x + DECK_BASES_DENSE_EXT.x0);
    console.info('deck-bases', {
      sparse: { at: DECK_BASES_SPARSE_AT, plates: sPlates, ext: DECK_BASES_SPARSE_EXT },
      dense: { at: DECK_BASES_DENSE_AT, plates: dPlates, ext: DECK_BASES_DENSE_EXT },
      spawn: { x: sx, y: DECK_BASES_OPTS.defaultSpawnY },
    });
  });
});
