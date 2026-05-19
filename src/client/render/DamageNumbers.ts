import { Container, Text, TextStyle } from 'pixi.js';
import type { Camera } from './worker/Camera';

const POOL_CAP = 20;
const LIFETIME_FRAMES = 60;

interface DamageNumberEntry {
  text: Text;
  framesLeft: number;
  /** weapon-hit-prediction Phase 2 — the originating `clientShotId` for a
   *  client-PREDICTED number, so `cancelByTag` can hard-cancel exactly
   *  this number on a mispredict / rollback / TTL-expiry. Undefined for
   *  authoritative (server `DamageEvent`) numbers. */
  tag?: string;
}

const STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 14,
  fontWeight: 'bold',
  fill: '#ffffff',
  dropShadow: {
    color: '#ff0000',
    blur: 2,
    distance: 1,
    angle: Math.PI / 2,
  },
});

/**
 * Floating damage-number manager.
 *
 * Numbers are children of the **world container** (pan with the camera,
 * anchored at the impact world coord) but counter-scaled per frame so
 * their visual size is constant regardless of camera zoom. Drift is in
 * world units per frame, scaled by `1 / camera.scale` so the
 * screen-space drift speed feels consistent at any zoom level.
 */
export class DamageNumberManager {
  private readonly container: Container;
  private readonly camera: Camera;
  private readonly active: DamageNumberEntry[] = [];

  constructor(worldParent: Container, camera: Camera) {
    this.container = new Container();
    worldParent.addChild(this.container);
    this.camera = camera;
  }

  spawn(x: number, y: number, damage: number, tag?: string): void {
    if (this.active.length >= POOL_CAP) {
      const oldest = this.active.shift();
      if (oldest) {
        this.container.removeChild(oldest.text);
        oldest.text.destroy();
      }
    }

    const text = new Text({ text: `-${damage}`, style: STYLE });
    text.anchor.set(0.5, 0.5);
    text.x = x;
    text.y = -y; // Y-flip: world +Y (up) → Pixi -Y
    this.container.addChild(text);
    this.active.push({ text, framesLeft: LIFETIME_FRAMES, tag });
  }

  /**
   * Hard-cancel every active number tagged with `tag` (a `clientShotId`).
   * The weapon-hit-prediction rollback / TTL-expiry channel: a mispredicted
   * predicted number vanishes immediately rather than lingering until its
   * natural fade. A multi-mount salvo shares one `clientShotId`, so all of
   * its predicted numbers cancel together. Untagged (authoritative) numbers
   * are never matched. Returns how many were removed.
   */
  cancelByTag(tag: string): number {
    let removed = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i]!;
      if (entry.tag !== tag) continue;
      this.container.removeChild(entry.text);
      entry.text.destroy();
      this.active.splice(i, 1);
      removed++;
    }
    return removed;
  }

  update(): void {
    // Counter-scale to neutralise the world container's zoom — the
    // text reads constant-size on screen regardless of camera zoom.
    // The drift rate also gets scaled so 1 visual pixel per frame
    // holds at any zoom level.
    const invScale = this.camera.scale.x > 0 ? 1 / this.camera.scale.x : 1;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i]!;
      entry.framesLeft--;
      entry.text.y -= invScale; // drift upward in world units (= 1 screen px)
      entry.text.scale.set(invScale);
      entry.text.alpha = entry.framesLeft / LIFETIME_FRAMES;

      if (entry.framesLeft <= 0) {
        this.container.removeChild(entry.text);
        entry.text.destroy();
        this.active.splice(i, 1);
      }
    }
  }

  /**
   * Number of damage-number entries currently alive. Surface for tests
   * + the renderer's feedback channel — `PixiRenderer` exposes this
   * via `RendererFeedback.damageNumberActiveCount` each frame so
   * integration tests can observe spawn/tick/expiry without rendering.
   */
  getActiveCount(): number {
    return this.active.length;
  }

  destroy(): void {
    for (const entry of this.active) {
      entry.text.destroy();
    }
    this.active.length = 0;
    this.container.destroy({ children: true });
  }
}
