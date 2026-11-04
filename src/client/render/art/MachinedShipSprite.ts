/**
 * Machined art — a ship's sprite: two stacked Sprites showing the two nearest
 * baked sun frames (`applySunBlend`). It stands in for the vector `Graphics`
 * in the renderer's sprite maps; position, rotation, tint (damage flash) and
 * children (mount barrels) work the same on it.
 */
import { Container, Sprite } from 'pixi.js';
import type { ShipArt } from './ArtService.js';
import { applySunBlend } from './machinedShipLight.js';

export class MachinedShipSprite extends Container {
  readonly a: Sprite;
  readonly b: Sprite;

  constructor(readonly art: ShipArt) {
    super();
    this.a = new Sprite(art.frames[0]!);
    this.b = new Sprite(art.frames[1 % art.frames.length]!);
    for (const s of [this.a, this.b]) {
      s.anchor.set(0.5);
      s.scale.set(1 / art.density);
      this.addChild(s);
    }
    this.b.alpha = 0;
  }

  /** Call after setting `rotation`, once per frame. */
  updateLight(sunAz: number): void {
    applySunBlend(this, this.art.frames, sunAz, this.rotation);
  }
}
