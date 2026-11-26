/**
 * Base platforms — the deck floor's plating texture (`?deckTex=`). Locks:
 * still ONE Graphics per plate with no children (the texture lives in the
 * shared plate context, a few seeded variants per look), plates turn only by
 * 60° steps, the pick is deterministic, `plain` is the slice-14 floor, and
 * the per-plate geometry stays within a counted budget (the phone is the
 * perf target: counted, never timed).
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics, buildContextBatches, type GraphicsContext } from 'pixi.js';
import type { DeckPlatesMirror } from '../../../core/contracts/IRenderer.js';
import { StructureDeckPlates, deckPlateContext } from './structureDeckPlates.js';
import { DECK_VARIANTS, DEFAULT_DECK_TEX, deckPlatePick, readDeckTex } from './structureDeckTexture.js';

function mirrorOf(version: number, plates: Array<[number, number]>): DeckPlatesMirror {
  const ij = new Int32Array(Math.max(2, plates.length * 2));
  plates.forEach(([i, j], n) => { ij[2 * n] = i; ij[2 * n + 1] = j; });
  return { version, count: plates.length, ij };
}

/** Geometry Pixi builds for one context (once, cached on the GPU context):
 *  vertices, triangles, batch elements, and how many distinct textures they
 *  use (1 = one draw call for the plate). */
function geometry(ctx: GraphicsContext): { verts: number; tris: number; elements: number; textures: number } {
  const gpu = { geometryData: { vertices: [] as number[], indices: [] as number[], uvs: [] as number[] }, batches: [] as Array<{ texture: unknown }> };
  buildContextBatches(ctx, gpu as unknown as Parameters<typeof buildContextBatches>[1]);
  const textures = new Set(gpu.batches.map((b) => b.texture)).size;
  return { verts: gpu.geometryData.vertices.length / 2, tris: gpu.geometryData.indices.length / 3, elements: gpu.batches.length, textures };
}

describe('deck floor texture (?deckTex=)', () => {
  it('reads plain | a | b; absent or unknown = the default (a)', () => {
    expect(DEFAULT_DECK_TEX).toBe('a');
    expect(readDeckTex('')).toBe('a');
    expect(readDeckTex('?room=x&deckTex=plain')).toBe('plain');
    expect(readDeckTex('?deckTex=b')).toBe('b');
    expect(readDeckTex('?deckTex=zz')).toBe('a');
  });

  it('a textured plate is still one childless Graphics on a shared variant context, turned by 60° steps', () => {
    for (const tex of ['a', 'b'] as const) {
      const ship = new Container();
      const deck = new StructureDeckPlates(ship, tex);
      const plates: Array<[number, number]> = [];
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) plates.push([i, j]);
      deck.sync(mirrorOf(1, plates));
      expect(ship.children.length).toBe(plates.length);
      const variants = new Set<GraphicsContext>();
      for (let v = 0; v < DECK_VARIANTS; v++) variants.add(deckPlateContext(tex, v));
      expect(variants.size).toBe(DECK_VARIANTS);
      const used = new Set<GraphicsContext>();
      const turns = new Set<number>();
      for (const ch of ship.children) {
        const g = ch as Graphics;
        expect(g.children.length).toBe(0);
        expect(variants.has(g.context)).toBe(true);
        used.add(g.context);
        const t = g.rotation / (Math.PI / 3);
        expect(Math.abs(t - Math.round(t))).toBeLessThan(1e-9);
        turns.add(Math.round(t));
      }
      expect(used.size).toBe(DECK_VARIANTS); // 49 plates use every variant
      expect(turns.size).toBeGreaterThan(3);
      deck.destroy();
      expect(ship.children.length).toBe(0);
      expect(deckPlateContext(tex, 0).destroyed).toBe(false);
    }
  });

  it('the pick is deterministic per plate and plain keeps the one unturned context', () => {
    expect(deckPlatePick(4, -2)).toEqual(deckPlatePick(4, -2));
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(mirrorOf(1, [[0, 0], [5, -3]]));
    for (const ch of ship.children) {
      expect((ch as Graphics).context).toBe(deckPlateContext());
      expect(ch.rotation).toBe(0);
    }
    expect(deckPlateContext('a', 1)).toBe(deckPlateContext('a', 1)); // built once
  });

  it('per-plate geometry stays within budget (counts printed for the PR)', () => {
    const plain = geometry(deckPlateContext('plain'));
    // Pixi batches a Graphics only under 400 vertices: the plain plate is
    // already over, so every plate (before and after) is its own draw call on
    // its context's cached GPU geometry, re-transformed on the GPU, never on
    // the CPU per frame. The texture must keep it that way: one texture.
    expect(plain.verts).toBeGreaterThan(400);
    expect(plain.textures).toBe(1);
    const rows: string[] = [`plain: ${plain.verts} verts, ${plain.tris} tris, ${plain.elements} batch elements`];
    for (const tex of ['a', 'b'] as const) {
      for (let v = 0; v < DECK_VARIANTS; v++) {
        const g = geometry(deckPlateContext(tex, v));
        rows.push(`${tex}:${v}: ${g.verts} verts, ${g.tris} tris, ${g.elements} batch elements`);
        // Budget: the texture adds at most 2.5k vertices to a plate (plain
        // ~8.5k, mostly the round-joined seams) and no texture (one draw call).
        expect(g.verts - plain.verts).toBeLessThan(2500);
        expect(g.textures).toBe(1);
      }
    }
    console.log(`[deckTex] per-plate geometry\n  ${rows.join('\n  ')}`);
  });
});
