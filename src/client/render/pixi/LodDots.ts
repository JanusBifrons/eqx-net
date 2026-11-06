/**
 * Screen-size level of detail (capital-ship R&D round 3 E1).
 *
 * When the camera pulls far back (a capital pilot's zoom range reaches ~5×
 * further than a fighter's), a fighter is a couple of pixels across: drawing
 * its baked hull, turrets and engine particles costs the same and reads as
 * noise. Below `LOD_TIERS.dotPx` on screen a ship or drone is drawn as a small
 * mark tinted by who it is (you, other pilots, drones, robots, traders) and its
 * sprite stops rendering (`renderable = false`, so its children — turrets —
 * go with it).
 *
 * Steady state allocates nothing (#14): one dot sprite per entity, created on
 * first sight; the tier flips only when the on-screen size crosses a
 * threshold (with hysteresis), and entities that left are swept by a
 * generation stamp.
 */
import { Container, Sprite, Texture } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { allegianceOfKind, getShipKind } from '../../../shared-types/shipKinds.js';

/** On-screen diameter thresholds (CSS px). `fullPx` is where a low-detail
 *  look would start (reserved: today full art draws down to `dotPx`). */
export const LOD_TIERS = { fullPx: 48, dotPx: 8, hysteresis: 1.25 } as const;
/** The dot's on-screen diameter (px). */
export const LOD_DOT_SIZE_PX = 3;

export const LOD_DOT_COLORS = {
  local: 0x6bff9b,
  player: 0x7fd8ff,
  drones: 0xffd479,
  robots: 0xff6b6b,
  traders: 0xc9b6ff,
} as const;

/** Dot tier with hysteresis: enter below `dotPx`, leave above `dotPx × h`. */
export function isDotTier(screenDiamPx: number, wasDot: boolean): boolean {
  return wasDot ? screenDiamPx < LOD_TIERS.dotPx * LOD_TIERS.hysteresis : screenDiamPx < LOD_TIERS.dotPx;
}

interface DotRec {
  dot: Sprite;
  isDot: boolean;
  gen: number;
}

export class LodDots {
  readonly container = new Container();
  private readonly ships = new Map<string, DotRec>();
  private readonly swarm = new Map<number, DotRec>();
  /** `swarm-<id>` sprite keys, built once per entity id. */
  private readonly swarmKeys = new Map<number, string>();
  private gen = 0;
  /** Entities currently drawn as dots (diagnostic / E2E). */
  dotCount = 0;

  /** Call after the ship + swarm sprites are posed this frame. */
  update(mirror: RenderMirror, sprites: Map<string, Container>, scale: number): void {
    const g = ++this.gen;
    let dots = 0;
    for (const [id, ship] of mirror.ships) {
      const sprite = sprites.get(id);
      if (!sprite) continue;
      const radius = getShipKind(ship.kind ?? null).radius;
      const color = id === mirror.localPlayerId ? LOD_DOT_COLORS.local : LOD_DOT_COLORS.player;
      if (this.apply(this.ships, id, sprite, radius, scale, color, g)) dots++;
    }
    if (mirror.swarm) {
      for (const [eid, e] of mirror.swarm) {
        if (e.kind !== 1) continue; // drones only (rocks, structures, scrap keep their art)
        let key = this.swarmKeys.get(eid);
        if (key === undefined) { key = `swarm-${eid}`; this.swarmKeys.set(eid, key); }
        const sprite = sprites.get(key);
        if (!sprite) continue;
        const color = LOD_DOT_COLORS[allegianceOfKind(e.shipKind)];
        if (this.apply(this.swarm, eid, sprite, e.radius, scale, color, g)) dots++;
      }
    }
    this.sweep(this.ships, g);
    this.sweep(this.swarm, g);
    for (const eid of this.swarmKeys.keys()) if (!this.swarm.has(eid)) this.swarmKeys.delete(eid);
    this.dotCount = dots;
  }

  private apply<K>(map: Map<K, DotRec>, key: K, sprite: Container, radius: number, scale: number, color: number, g: number): boolean {
    let rec = map.get(key);
    if (!rec) {
      const dot = new Sprite(Texture.WHITE);
      dot.anchor.set(0.5);
      dot.visible = false;
      this.container.addChild(dot);
      rec = { dot, isDot: false, gen: g };
      map.set(key, rec);
    }
    rec.gen = g;
    const dotNow = isDotTier(2 * radius * scale, rec.isDot);
    if (dotNow !== rec.isDot) {
      rec.isDot = dotNow;
      rec.dot.visible = dotNow;
      if (!dotNow) sprite.renderable = true;
    }
    if (dotNow) {
      // Every frame: an art swap can replace the sprite object.
      sprite.renderable = false;
      rec.dot.tint = color;
      rec.dot.position.set(sprite.x, sprite.y);
      rec.dot.scale.set(LOD_DOT_SIZE_PX / scale);
    }
    return dotNow;
  }

  private sweep<K>(map: Map<K, DotRec>, g: number): void {
    for (const [k, rec] of map) {
      if (rec.gen === g) continue;
      rec.dot.destroy();
      map.delete(k);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.ships.clear();
    this.swarm.clear();
    this.swarmKeys.clear();
  }
}
