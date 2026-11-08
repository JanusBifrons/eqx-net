/**
 * Machined art — a structure's or asteroid's sprite: one lit frame. These
 * don't spin, so the bake already accounts for their turn (the sun stays
 * where the sector puts it). Children (mount barrels, readouts, rings) attach
 * to it exactly as they did to the vector `Graphics`.
 */
import { Container, Sprite } from 'pixi.js';
import type { StructArt } from './ArtService.js';
import { LitShipMesh } from './litShipShader.js';
import { litPass } from './litPass.js';
import { flatLook } from './lightingSettings.js';

export class MachinedFlatSprite extends Container {
  readonly body: Sprite;
  /** GPU-lit art (`?shiplight=gpu` with lit structures / rocks). */
  readonly lit: LitShipMesh | null = null;

  constructor(readonly art: StructArt) {
    super();
    const settings = litPass.settings;
    if (art.lit && settings) {
      this.body = new Sprite();
      const l = art.lit;
      this.lit = new LitShipMesh({ tex: art.tex, w: l.w, rows: l.h, y0: 0, hullH: l.h, ppu: l.ppu, maxH: l.maxH, emisMax: l.emisMax }, flatLook(settings));
      this.addChild(this.lit);
      litPass.register(this.lit);
      return;
    }
    this.body = new Sprite(art.tex);
    this.body.anchor.set(0.5);
    this.body.scale.set(1 / art.density);
    this.addChild(this.body);
  }
}
