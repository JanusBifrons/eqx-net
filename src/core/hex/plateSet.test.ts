import { describe, expect, it } from 'vitest';
import { PlateSet, PLATE_CENTRE_TOLERANCE, plateCentreAtWorldInto } from './plateSet.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreWorldInto, plateHexes } from './plates.js';

const at = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });

function plates(ps: PlateSet<string>, owner: string): string[] {
  const out: string[] = [];
  ps.forEachPlate(owner, (i, j) => out.push(`${i},${j}`));
  return out.sort();
}

describe('PlateSet — the derived plate set', () => {
  it('a connector on a plate centre makes a plate; removing it drops the plate', () => {
    const ps = new PlateSet<string>();
    const c = at(2, -1);
    ps.upsert('a', 'alice', 'connector', c.x, c.y);
    expect(ps.hasPlate('alice', 2, -1)).toBe(true);
    expect(ps.plateCount('alice')).toBe(1);
    ps.remove('a');
    expect(ps.hasPlate('alice', 2, -1)).toBe(false);
    expect(ps.plateCount('alice')).toBe(0);
  });

  it('a connector within the tolerance anchors; one off-centre does not', () => {
    const ps = new PlateSet<string>();
    const c = at(1, 1);
    ps.upsert('near', 'alice', 'connector', c.x + PLATE_CENTRE_TOLERANCE * 0.5, c.y);
    expect(ps.hasPlate('alice', 1, 1)).toBe(true);
    ps.upsert('off', 'bob', 'connector', c.x + 50, c.y);
    expect(ps.plateCount('bob')).toBe(0);
    // A connector on a ring hex's centre (not the plate's middle hex) is no plate.
    const ring = plateHexes(1, 1)[3]!;
    const p = deckHexCentreInto(ring.q, ring.r, { x: 0, y: 0 });
    ps.upsert('ring', 'bob', 'connector', p.x, p.y);
    expect(ps.plateCount('bob')).toBe(0);
  });

  it('only connector kinds anchor a plate', () => {
    const ps = new PlateSet<string>();
    const c = at(0, 0);
    ps.upsert('s', 'alice', 'solar', c.x, c.y);
    ps.upsert('u', 'alice', undefined, c.x, c.y);
    expect(ps.plateCount('alice')).toBe(0);
  });

  it('a blueprint connector counts (the set ignores build state)', () => {
    // Blueprint or built, a record reaches the set the same way: the server
    // registry and the client mirror upsert both; see plateSetParity.
    const ps = new PlateSet<string>();
    const c = at(-3, 2);
    ps.upsert('bp', 'alice', 'connector', c.x, c.y);
    expect(ps.hasPlate('alice', -3, 2)).toBe(true);
  });

  it('plates are owner-scoped; an owner change moves the plate', () => {
    const ps = new PlateSet<string>();
    const c = at(0, 1);
    ps.upsert('a', 'alice', 'connector', c.x, c.y);
    expect(ps.hasPlate('bob', 0, 1)).toBe(false);
    expect(ps.plateAtWorld('bob', c.x, c.y)).toBe(false);
    ps.upsert('a', 'bob', 'connector', c.x, c.y);
    expect(ps.hasPlate('alice', 0, 1)).toBe(false);
    expect(ps.hasPlate('bob', 0, 1)).toBe(true);
    expect(ps.anchorOwner('a')).toBe('bob');
  });

  it('two anchors on one plate: the plate stays until both go', () => {
    const ps = new PlateSet<string>();
    const c = at(0, 0);
    ps.upsert('a', 'alice', 'connector', c.x, c.y);
    ps.upsert('b', 'alice', 'connector', c.x, c.y);
    ps.upsert('d', 'alice', 'connector', at(1, 0).x, at(1, 0).y);
    ps.remove('a');
    expect(plates(ps, 'alice')).toEqual(['0,0', '1,0']);
    ps.remove('b');
    expect(plates(ps, 'alice')).toEqual(['1,0']);
    ps.upsert('d', 'alice', 'solar', 0, 0); // kind change drops it
    expect(plates(ps, 'alice')).toEqual([]);
    ps.remove('nope'); // unknown id is a no-op
  });

  it('plateAtWorld is true on all 7 hex centres of the plate and false just outside', () => {
    const ps = new PlateSet<string>();
    const c = at(-2, 3);
    ps.upsert('a', 'alice', 'connector', c.x, c.y);
    const hexes = plateHexes(-2, 3);
    const p = { x: 0, y: 0 };
    for (const h of hexes) {
      deckHexCentreInto(h.q, h.r, p);
      expect(ps.plateAtWorld('alice', p.x, p.y)).toBe(true);
    }
    // Just outside: past each ring hex's outer flat side (away from the centre).
    const inner = DECK_HEX_SIZE * Math.sqrt(3) / 2; // centre to flat side
    for (const h of hexes.slice(1)) {
      deckHexCentreInto(h.q, h.r, p);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const len = Math.hypot(dx, dy);
      const ox = p.x + (dx / len) * (inner + 5);
      const oy = p.y + (dy / len) * (inner + 5);
      expect(ps.plateAtWorld('alice', ox, oy)).toBe(false);
      const ix = p.x + (dx / len) * (inner - 5);
      const iy = p.y + (dy / len) * (inner - 5);
      expect(ps.plateAtWorld('alice', ix, iy)).toBe(true);
    }
  });

  it('plateCentreAtWorldInto finds the plate under a centre', () => {
    const out = { i: 0, j: 0 };
    const c = at(4, -2);
    expect(plateCentreAtWorldInto(c.x, c.y, out)).toBe(true);
    expect(out).toEqual({ i: 4, j: -2 });
  });
});

describe('PlateSet.version — readers cache against it', () => {
  it('moves when a plate appears or goes, not on a second anchor of a held plate', () => {
    const ps = new PlateSet<string>();
    const c = at(0, 0);
    const v0 = ps.version;
    ps.upsert('a', 'alice', 'connector', c.x, c.y);
    const v1 = ps.version;
    expect(v1).toBeGreaterThan(v0);
    ps.upsert('b', 'alice', 'connector', c.x, c.y); // same plate, second anchor
    ps.upsert('a', 'alice', 'connector', c.x, c.y); // idempotent re-state
    expect(ps.version).toBe(v1);
    ps.remove('a');
    expect(ps.version).toBe(v1); // 'b' still holds it
    ps.remove('b');
    expect(ps.version).toBeGreaterThan(v1);
    const seen: string[] = [];
    ps.upsert('c', 'bob', 'connector', c.x, c.y);
    ps.forEachOwnerPlate((o, i, j) => seen.push(`${o}:${i},${j}`));
    expect(seen).toEqual(['bob:0,0']);
  });
});
