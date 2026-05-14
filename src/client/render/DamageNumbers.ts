import { Container, Text, TextStyle } from 'pixi.js';
import type { Camera } from './worker/Camera';

const POOL_CAP = 20;
const LIFETIME_FRAMES = 60;

interface DamageNumberEntry {
  text: Text;
  framesLeft: number;
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
 * Floating damage-number manager. 2026-05-14: attached to `app.stage`
 * (screen-space) instead of the world container, so numbers no longer
 * scale with zoom and stay readable. Per-spawn we convert the entity's
 * world coord → screen coord via `camera.toScreen`; the number then
 * drifts upward in screen pixels for its lifetime.
 */
export class DamageNumberManager {
  private readonly container: Container;
  private readonly camera: Camera;
  private readonly active: DamageNumberEntry[] = [];

  constructor(stageParent: Container, camera: Camera) {
    this.container = new Container();
    stageParent.addChild(this.container);
    this.camera = camera;
  }

  spawn(x: number, y: number, damage: number): void {
    if (this.active.length >= POOL_CAP) {
      const oldest = this.active.shift();
      if (oldest) {
        this.container.removeChild(oldest.text);
        oldest.text.destroy();
      }
    }

    const text = new Text({ text: `-${damage}`, style: STYLE });
    text.anchor.set(0.5, 0.5);
    // World coord → Pixi-space (Y-flip) → screen coord.
    const screen = this.camera.toScreen(x, -y);
    text.x = screen.x;
    text.y = screen.y;
    this.container.addChild(text);
    this.active.push({ text, framesLeft: LIFETIME_FRAMES });
  }

  update(): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i]!;
      entry.framesLeft--;
      entry.text.y -= 1; // drift upward in Pixi coords
      entry.text.alpha = entry.framesLeft / LIFETIME_FRAMES;

      if (entry.framesLeft <= 0) {
        this.container.removeChild(entry.text);
        entry.text.destroy();
        this.active.splice(i, 1);
      }
    }
  }

  destroy(): void {
    for (const entry of this.active) {
      entry.text.destroy();
    }
    this.active.length = 0;
    this.container.destroy({ children: true });
  }
}
