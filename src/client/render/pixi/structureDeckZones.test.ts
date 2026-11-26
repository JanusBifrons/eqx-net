/**
 * Base platforms slice 33 — zone markings painted on the deck floor. Locks:
 * which kinds get which marking (no industry stripes: dropped 2026-11-26),
 * gun paint turns with its building, the gun ring and the Capital's hex
 * border (never turned), deck rooms only, paint goes with its building, and
 * an unchanged frame builds nothing (counted, not timed).
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import type { DeckPlatesMirror } from '../../../core/contracts/IRenderer.js';
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { getStructureKind } from '../../../shared-types/structureKinds/lookup.js';
import { DECK_UNDER_Z, StructureDeckPlates } from './structureDeckPlates.js';
import type { StructureRenderState } from '../../../core/contracts/render/StructureRenderState.js';
import { RIG_UNDER_Z } from './structureRigs.js';
import { isUnderConstruction } from './structureHologram.js';
import {
  CAPITAL_LINE, CAPITAL_OUTER, DECK_ZONE_Z, GUN_MARGIN, GUN_RING_WIDTH,
  deckZoneContext, deckZoneOf, readZonesFlag,
} from './structureDeckZones.js';

function plates(version: number, deck: boolean): DeckPlatesMirror {
  return { version, count: 0, ij: new Int32Array(2), deck };
}

function zoneGraphics(c: Container): Graphics[] {
  return c.children.filter((ch): ch is Graphics => ch instanceof Graphics && ch.label === 'deckZone');
}

describe('deck zone markings — which kinds', () => {
  it('industry gets no paint (hazard stripes dropped by the owner)', () => {
    for (const k of ['refinery', 'smelter', 'silicon_works', 'reclaimer', 'cargo_bay', 'freight_dock', 'shipyard', 'miner']) {
      expect(deckZoneOf(k)).toBeNull();
    }
  });
  it('guns: turrets and coastal guns; capital: the Capital; others none', () => {
    for (const k of ['turret', 'missile_turret', 'aa_quad_40mm', 'siege_gun_80cm']) expect(deckZoneOf(k)).toBe('gun');
    expect(deckZoneOf('capital')).toBe('capital');
    for (const k of ['solar', 'connector', 'shield_pylon', 'storage_vault', 'teleporter', 'bogus', undefined]) {
      expect(deckZoneOf(k)).toBeNull();
    }
  });
  it('?zones= parses (default on)', () => {
    expect(readZonesFlag('')).toBe(true);
    expect(readZonesFlag('?zones=on')).toBe(true);
    expect(readZonesFlag('?a=1&zones=off')).toBe(false);
  });
});

describe('deck zone markings — the paint', () => {
  it('gun paint sits on its building and turns with it', () => {
    const b = deckZoneContext('missile_turret')!.bounds;
    expect(b.maxX).toBeCloseTo(getStructureKind('missile_turret').radius + GUN_MARGIN + GUN_RING_WIDTH / 2, 0);
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(plates(1, true));
    deck.zones!.note(7, 'missile_turret', 100, 200, Math.PI / 2);
    const g = deck.zones!.graphicsOf(7)!;
    expect(g.context).toBe(deckZoneContext('missile_turret'));
    expect(g.x).toBe(100);
    expect(g.y).toBe(-200); // Y-flip
    expect(g.rotation).toBeCloseTo(-Math.PI / 2);
  });

  it('gun ring round the bounding circle; Capital hex border never turns', () => {
    const r = getStructureKind('turret').radius + GUN_MARGIN;
    expect(deckZoneContext('turret')!.bounds.maxX).toBeCloseTo(r + GUN_RING_WIDTH / 2, 0);
    const cb = deckZoneContext('capital')!.bounds;
    expect(cb.maxY).toBeGreaterThan(DECK_HEX_SIZE * CAPITAL_OUTER);
    expect(cb.maxY).toBeLessThan(DECK_HEX_SIZE * CAPITAL_OUTER + CAPITAL_LINE);
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(plates(1, true));
    deck.zones!.note(1, 'capital', 0, 0, Math.PI / 2);
    deck.zones!.note(2, 'turret', 500, 0, 1);
    deck.zones!.note(3, 'solar', 900, 0, 0);
    expect(deck.zones!.graphicsOf(1)!.rotation).toBe(0);
    expect(deck.zones!.graphicsOf(2)!.context).toBe(deckZoneContext('turret'));
    expect(deck.zones!.graphicsOf(3)).toBeUndefined();
    expect(zoneGraphics(ship).length).toBe(2);
  });

  it('flat floor paint: above the plates, below the rig under band', () => {
    expect(DECK_ZONE_Z).toBeGreaterThan(DECK_UNDER_Z);
    expect(DECK_ZONE_Z).toBeLessThan(RIG_UNDER_Z);
  });
});

describe('deck zone markings — lifetime', () => {
  it('off-deck draws nothing; leaving the deck clears the paint', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(plates(1, false));
    deck.zones!.note(1, 'missile_turret', 0, 0, 0);
    expect(deck.zones!.size).toBe(0);
    deck.sync(plates(2, true));
    deck.zones!.note(1, 'missile_turret', 0, 0, 0);
    expect(deck.zones!.size).toBe(1);
    deck.sync(plates(3, false));
    expect(deck.zones!.size).toBe(0);
    expect(zoneGraphics(ship).length).toBe(0);
  });

  it('a building gone from the frame loses its paint; a steady frame builds nothing', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    const pm = plates(1, true);
    deck.sync(pm);
    deck.zones!.note(1, 'missile_turret', 0, 0, 0);
    deck.zones!.note(2, 'turret', 500, 0, 0);
    const g1 = deck.zones!.graphicsOf(1);
    deck.sync(pm); // next frame: both still there
    deck.zones!.note(1, 'missile_turret', 0, 0, 0);
    deck.zones!.note(2, 'turret', 500, 0, 0);
    expect(deck.zones!.graphicsOf(1)).toBe(g1);
    deck.sync(pm); // turret destroyed: not noted last frame
    deck.zones!.note(1, 'missile_turret', 0, 0, 0);
    deck.sync(pm);
    expect(deck.zones!.size).toBe(1);
    expect(deck.zones!.graphicsOf(2)).toBeUndefined();
    expect(zoneGraphics(ship).length).toBe(1);
  });

  it('a gun under construction gets no danger zone; once built, it does', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    const pm = plates(1, true);
    const st = { built: false } as StructureRenderState;
    deck.sync(pm);
    deck.note(1, 'turret', 0, 0, 0, isUnderConstruction(st)); // the hologram's predicate
    deck.note(2, 'turret', 500, 0, 0, isUnderConstruction(undefined)); // no state yet: built
    expect(deck.zones!.graphicsOf(1)).toBeUndefined();
    expect(deck.zones!.graphicsOf(2)).toBeDefined();
    expect(zoneGraphics(ship).length).toBe(1);
    deck.sync(pm);
    st.built = true;
    deck.note(1, 'turret', 0, 0, 0, isUnderConstruction(st));
    deck.note(2, 'turret', 500, 0, 0, isUnderConstruction(undefined));
    expect(deck.zones!.graphicsOf(1)).toBeDefined();
    expect(zoneGraphics(ship).length).toBe(2);
  });

  it('?zones=off: the floor has no zone layer', () => {
    expect(new StructureDeckPlates(new Container(), 'plain', false).zones).toBeUndefined();
  });
});
