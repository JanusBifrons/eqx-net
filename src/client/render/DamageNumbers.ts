import { Container, Text, TextStyle } from 'pixi.js';

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

export class DamageNumberManager {
  private readonly container: Container;
  private readonly active: DamageNumberEntry[] = [];

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);
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
    text.x = x;
    text.y = -y; // Y-flip: world +Y → Pixi -Y
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
