/**
 * Machined art — a ship's sprite: two stacked Sprites showing the two nearest
 * baked sun frames (`applySunBlend`). It stands in for the vector `Graphics`
 * in the renderer's sprite maps; position, rotation, tint (damage flash) and
 * children (mount barrels) work the same on it.
 *
 * A tiled capital hull (round 3 E) has one sprite pair per tile, stacked
 * along the hull, all switched to the same two sun frames.
 */
import { Container, Sprite } from 'pixi.js';
import type { ShipArt } from './ArtService.js';
import { applySunBlend, sunFrameBlend, type SunBlend } from './machinedShipLight.js';

const _blend: SunBlend = { j0: 0, j1: 0, t: 0 };

export class MachinedShipSprite extends Container {
  readonly a: Sprite;
  readonly b: Sprite;
  /** Per tile (index 0 is `a`/`b`); empty for an untiled ship. */
  private readonly tileA: Sprite[] = [];
  private readonly tileB: Sprite[] = [];

  constructor(readonly art: ShipArt) {
    super();
    const tiles = art.tiles;
    this.a = new Sprite(art.frames[0]!);
    this.b = new Sprite(art.frames[tiles % art.frames.length]!);
    if (tiles <= 1) {
      for (const s of [this.a, this.b]) {
        s.anchor.set(0.5);
        s.scale.set(1 / art.density);
        this.addChild(s);
      }
      this.b.alpha = 0;
      return;
    }
    for (let t = 0; t < tiles; t++) {
      const a = t === 0 ? this.a : new Sprite(art.frames[t]!);
      const b = t === 0 ? this.b : new Sprite(art.frames[(tiles + t) % art.frames.length]!);
      for (const s of [a, b]) {
        s.anchor.set(0.5, 0);
        s.scale.set(1 / art.density);
        s.y = (t * art.tileH - art.h / 2) / art.density;
        this.addChild(s);
      }
      b.alpha = 0;
      this.tileA.push(a);
      this.tileB.push(b);
    }
  }

  /** Call after setting `rotation`, once per frame. */
  updateLight(sunAz: number): void {
    const tiles = this.art.tiles;
    if (tiles <= 1) { applySunBlend(this, this.art.frames, sunAz, this.rotation); return; }
    const steps = Math.floor(this.art.frames.length / tiles);
    sunFrameBlend(sunAz, this.rotation, steps, _blend);
    const f = this.art.frames;
    for (let t = 0; t < tiles; t++) {
      this.tileA[t]!.texture = f[_blend.j0 * tiles + t]!;
      const b = this.tileB[t]!;
      b.texture = f[_blend.j1 * tiles + t]!;
      b.alpha = _blend.t;
    }
  }
}
