/**
 * Machined art — a structure's or asteroid's sprite: one lit frame. These
 * don't spin, so the bake already accounts for their turn (the sun stays
 * where the sector puts it). Children (mount barrels, readouts, rings) attach
 * to it exactly as they did to the vector `Graphics`.
 */
import { Container, Sprite } from 'pixi.js';
import type { StructArt } from './ArtService.js';

export class MachinedFlatSprite extends Container {
  readonly body: Sprite;

  constructor(readonly art: StructArt) {
    super();
    this.body = new Sprite(art.tex);
    this.body.anchor.set(0.5);
    this.body.scale.set(1 / art.density);
    this.addChild(this.body);
  }
}
