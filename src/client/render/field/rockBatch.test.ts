/**
 * Placed rocks and cut pieces draw in ONE mesh (`rockBatch.ts`): the draw
 * calls do not grow with their count. Each member's vertices land where its
 * own mesh would have drawn them (its pose up to the batch's parent), with
 * its axes (`aXf`, the sun) and colour (`aTint`, premultiplied); a hidden or
 * detached member draws nothing; nothing is rebuilt while nothing changes.
 */
import { describe, expect, it, vi } from 'vitest';

// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('./fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockBatchProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { Container, Mesh } from 'pixi.js';
import { CutFieldLayer } from './CutFieldLayer';
import { placedRockMeshData } from './placedRockMesh';

const LOOK = { shape: 77, r: 120 };

function setup(): { layer: CutFieldLayer; ships: Container; mesh: Mesh } {
  const layer = new CutFieldLayer();
  const ships = new Container();
  ships.addChild(layer.rockBatch.layer);
  return { layer, ships, mesh: layer.rockBatch.layer.children[0] as Mesh };
}

describe('placed rocks and pieces draw in one rock batch', () => {
  it('one mesh, whatever the number of rocks', () => {
    const { layer, ships, mesh } = setup();
    for (let i = 0; i < 40; i++) ships.addChild(layer.buildRockMesh(placedRockMeshData({ shape: i, r: 60 + i })));
    layer.rockBatch.sync();
    expect(layer.rockBatch.layer.children.length).toBe(1);
    expect(mesh.visible).toBe(true);
    let tris = 0;
    for (let i = 0; i < 40; i++) tris += placedRockMeshData({ shape: i, r: 60 + i }).indices.length;
    expect(mesh.geometry.indices.length).toBe(tris);
  });

  it('a member draws where its own mesh would: its pose (and its parents\') up to the batch parent', () => {
    const { layer, ships, mesh } = setup();
    const d = placedRockMeshData(LOOK);
    const holder = new Container();
    holder.position.set(500, -300);
    holder.rotation = 0.4;
    const m = layer.buildRockMesh(d);
    m.position.set(20, 10);
    m.rotation = 1.1;
    holder.addChild(m);
    ships.addChild(holder);
    layer.rockBatch.sync();
    // The same transform Pixi would give m's own mesh, relative to `ships`.
    const w = holder.localTransform.clone().append(m.localTransform);
    const pos = mesh.geometry.positions;
    for (let v = 0; v < d.positions.length / 2; v++) {
      const x = d.positions[v * 2]!, y = d.positions[v * 2 + 1]!;
      expect(pos[v * 2]).toBeCloseTo(w.a * x + w.c * y + w.tx, 2);
      expect(pos[v * 2 + 1]).toBeCloseTo(w.b * x + w.d * y + w.ty, 2);
    }
    const xf = mesh.geometry.getBuffer('aXf').data as Float32Array;
    expect(xf[0]).toBeCloseTo(Math.cos(1.5), 5);
    expect(xf[1]).toBeCloseTo(Math.sin(1.5), 5);
    expect(xf[2]).toBeCloseTo(-Math.sin(1.5), 5);
    expect(xf[3]).toBeCloseTo(Math.cos(1.5), 5);
  });

  it('tint and alpha up the chain go into aTint, premultiplied (the hit flash still shows)', () => {
    const { layer, ships, mesh } = setup();
    const holder = new Container();
    holder.alpha = 0.5;
    const m = layer.buildRockMesh(placedRockMeshData(LOOK));
    m.tint = 0xff0000;
    holder.addChild(m);
    ships.addChild(holder);
    layer.rockBatch.sync();
    const t = mesh.geometry.getBuffer('aTint').data as Float32Array;
    expect(t[0]).toBeCloseTo(0.5, 2);
    expect(t[1]).toBe(0);
    expect(t[2]).toBe(0);
    expect(t[3]).toBeCloseTo(0.5, 2);
  });

  it('a hidden, unrenderable or detached member collapses to a point', () => {
    const { layer, ships, mesh } = setup();
    const n = placedRockMeshData(LOOK).positions.length / 2;
    const m = layer.buildRockMesh(placedRockMeshData(LOOK));
    const holder = new Container();
    holder.addChild(m);
    ships.addChild(holder);
    const collapsed = (): boolean => {
      const p = mesh.geometry.positions;
      for (let v = 1; v < n; v++) if (p[v * 2] !== p[0] || p[v * 2 + 1] !== p[1]) return false;
      return true;
    };
    layer.rockBatch.sync();
    expect(collapsed()).toBe(false);
    holder.renderable = false; // a far-zoom wreck piece's art
    layer.rockBatch.sync();
    expect(collapsed()).toBe(true);
    holder.renderable = true;
    m.visible = false;
    layer.rockBatch.sync();
    expect(collapsed()).toBe(true);
    m.visible = true;
    layer.rockBatch.sync();
    expect(collapsed()).toBe(false);
    ships.removeChild(holder);
    layer.rockBatch.sync();
    expect(collapsed()).toBe(true);
  });

  it('nothing is rebuilt or re-uploaded while nothing changes; a destroyed member leaves the batch', () => {
    const { layer, ships, mesh } = setup();
    const a = layer.buildRockMesh(placedRockMeshData(LOOK));
    const b = layer.buildRockMesh(placedRockMeshData({ shape: 5, r: 90 }));
    ships.addChild(a, b);
    layer.rockBatch.sync();
    const buf = mesh.geometry.getBuffer('aPosition');
    const data = buf.data;
    const spy = vi.spyOn(buf, 'update');
    layer.rockBatch.sync();
    expect(spy).not.toHaveBeenCalled();
    expect(buf.data).toBe(data);
    a.x = 5;
    layer.rockBatch.sync();
    expect(spy).toHaveBeenCalledTimes(1);
    b.destroy();
    layer.rockBatch.sync();
    expect(layer.rockBatch.count).toBe(1);
    expect(mesh.geometry.indices.length).toBe(placedRockMeshData(LOOK).indices.length);
    a.destroy();
    layer.rockBatch.sync();
    expect(mesh.visible).toBe(false);
  });
});
