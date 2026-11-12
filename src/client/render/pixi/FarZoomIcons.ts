/**
 * Far-zoom ship icons (owner decision 2026-11-12; replaces the capital-ship
 * R&D round 3 E1 "LOD dots").
 *
 * When the camera pulls far back (a capital pilot's floor reaches ~0.03 and
 * below) a fighter is a few pixels across. The old LOD dots drew it as a 3 px
 * square, which vanished on a phone. Now every ship and drone whose true
 * sprite gets small on screen gains a CONSTANT-SCREEN-SIZE chevron
 * (`FAR_ICON.sizePx`, like an RTS unit marker) pointing along its heading and
 * tinted by relationship (you / friendly pilots / hostile / neutral / trader,
 * the radar's category colours). It FADES IN as the sprite shrinks from
 * `fadeStartPx` to `solidPx`, so nothing pops; once it is solid the sprite
 * stops rendering (`renderable = false`, so its children — turrets — go
 * with it) and comes back with hysteresis.
 *
 * Scope: player ships (`mirror.ships`) and drones (swarm kind 1). Asteroids,
 * structures and scrap keep their art. Every player sees it.
 *
 * Cost: one sprite per entity, created on first sight and swept by a
 * generation stamp; all icons share ONE texture, so they batch into one draw
 * call. Steady state allocates nothing (#14).
 */
import { Container, Sprite, Texture } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { DEFAULT_RADAR_PREFS, type RadarPrefs } from '../../../shared-types/settings/radar.js';

/**
 * Thresholds, in CSS px of the TRUE sprite's on-screen diameter.
 *  - `sizePx`: the icon's constant on-screen size.
 *  - `fadeStartPx`: the icon starts to fade in below this.
 *  - `solidPx`: the icon is fully opaque at and below this, and the sprite
 *    stops rendering (it would be no bigger than the icon covering it).
 *  - `hysteresis`: the sprite comes back only above `solidPx × hysteresis`.
 */
export const FAR_ICON = { sizePx: 10, fadeStartPx: 14, solidPx: 8, hysteresis: 1.25 } as const;

/** Icon opacity for a true on-screen diameter: 0 at/above `fadeStartPx`,
 *  1 at/below `solidPx`, linear between. Pure. */
export function farIconAlpha(screenDiamPx: number): number {
  if (screenDiamPx >= FAR_ICON.fadeStartPx) return 0;
  if (screenDiamPx <= FAR_ICON.solidPx) return 1;
  return (FAR_ICON.fadeStartPx - screenDiamPx) / (FAR_ICON.fadeStartPx - FAR_ICON.solidPx);
}

/** Sprite hidden (icon only), with hysteresis: enter below `solidPx`, leave
 *  above `solidPx × hysteresis`. Pure. */
export function isIconOnly(screenDiamPx: number, wasIconOnly: boolean): boolean {
  return wasIconOnly
    ? screenDiamPx < FAR_ICON.solidPx * FAR_ICON.hysteresis
    : screenDiamPx < FAR_ICON.solidPx;
}

export type FarIconRelation = 'self' | 'friendly' | 'hostile' | 'neutral' | 'trader';

/** Relationship of an entity to the local player, as the radar and contacts
 *  list read it: other pilots are friendly; a drone is hostile when its AI
 *  targets you (`isHostileToLocal`), a trade hauler is a trader, else neutral. */
export function farIconRelation(isLocal: boolean, isPlayer: boolean, hostile: boolean, shipKind: string | undefined): FarIconRelation {
  if (isLocal) return 'self';
  if (isPlayer) return 'friendly';
  if (hostile) return 'hostile';
  return shipKind === 'trader-hauler' ? 'trader' : 'neutral';
}

export interface FarIconColours {
  hostile: number;
  friendly: number;
  neutral: number;
  trader: number;
}

const D = DEFAULT_RADAR_PREFS.desktop.categories;
/** The radar's default category colours (hostile red, pilot green, neutral
 *  amber, trader teal). */
export const DEFAULT_FAR_ICON_COLOURS: Readonly<FarIconColours> = {
  hostile: D.hostile.color,
  friendly: D.player.color,
  neutral: D.neutral.color,
  trader: D.trader.color,
};
/** Your own ship: white, apart from every relationship colour. */
export const FAR_ICON_SELF_COLOUR = 0xffffff;

/** Texture size (px) the chevron is painted at; scaled down to `sizePx`. */
const ICON_TEX_PX = 32;

/** One shared white chevron (nose up = local −y, the ship's forward), built
 *  once on a canvas; Texture.WHITE where there is no canvas (unit tests). */
let iconTex: Texture | null = null;
export function farIconTexture(): Texture {
  if (iconTex) return iconTex;
  try {
    const C = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas }).OffscreenCanvas;
    const canvas = C
      ? new C(ICON_TEX_PX, ICON_TEX_PX)
      : typeof document !== 'undefined'
        ? Object.assign(document.createElement('canvas'), { width: ICON_TEX_PX, height: ICON_TEX_PX })
        : null;
    const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (!canvas || !ctx) { iconTex = Texture.WHITE; return iconTex; }
    const s = ICON_TEX_PX;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.08); // nose
    ctx.lineTo(s * 0.88, s * 0.9);
    ctx.lineTo(s * 0.5, s * 0.68); // notch
    ctx.lineTo(s * 0.12, s * 0.9);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    // Dark rim: stays dark under any tint, so the icon reads on bright art.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(5,7,13,0.75)';
    ctx.stroke();
    iconTex = Texture.from(canvas as unknown as HTMLCanvasElement);
    return iconTex;
  } catch {
    iconTex = Texture.WHITE;
    return iconTex;
  }
}

interface IconRec {
  icon: Sprite;
  iconOnly: boolean;
  gen: number;
}

export class FarZoomIcons {
  readonly container = new Container();
  private readonly ships = new Map<string, IconRec>();
  private readonly swarm = new Map<number, IconRec>();
  /** `swarm-<id>` sprite keys, built once per entity id. */
  private readonly swarmKeys = new Map<number, string>();
  private readonly colours: FarIconColours = { ...DEFAULT_FAR_ICON_COLOURS };
  private gen = 0;
  /** Entities whose sprite is replaced by its icon (diagnostic / E2E,
   *  `__eqxArtStats().lodDots`). */
  iconCount = 0;

  /** Follow the player's radar colours (Settings → Radar). */
  setColours(c: FarIconColours): void {
    this.colours.hostile = c.hostile;
    this.colours.friendly = c.friendly;
    this.colours.neutral = c.neutral;
    this.colours.trader = c.trader;
  }

  setColoursFromRadar(prefs: RadarPrefs): void {
    const cats = prefs.categories;
    this.colours.hostile = cats.hostile.color;
    this.colours.friendly = cats.player.color;
    this.colours.neutral = cats.neutral.color;
    this.colours.trader = cats.trader.color;
  }

  private colourOf(rel: FarIconRelation): number {
    return rel === 'self' ? FAR_ICON_SELF_COLOUR : this.colours[rel];
  }

  /** Call after the ship + swarm sprites are posed this frame. */
  update(mirror: RenderMirror, sprites: Map<string, Container>, scale: number): void {
    const g = ++this.gen;
    let n = 0;
    for (const [id, ship] of mirror.ships) {
      const sprite = sprites.get(id);
      if (!sprite) continue;
      const radius = getShipKind(ship.kind ?? null).radius;
      const isLocal = id === mirror.localPlayerId;
      const colour = this.colourOf(farIconRelation(isLocal, !isLocal, false, ship.kind));
      if (this.apply(this.ships, id, sprite, radius, scale, colour, g)) n++;
    }
    if (mirror.swarm) {
      for (const [eid, e] of mirror.swarm) {
        if (e.kind !== 1) continue; // drones only (rocks, structures, scrap keep their art)
        let key = this.swarmKeys.get(eid);
        if (key === undefined) { key = `swarm-${eid}`; this.swarmKeys.set(eid, key); }
        const sprite = sprites.get(key);
        if (!sprite) continue;
        const colour = this.colourOf(farIconRelation(false, false, e.isHostileToLocal === true, e.shipKind));
        if (this.apply(this.swarm, eid, sprite, e.radius, scale, colour, g)) n++;
      }
    }
    this.sweep(this.ships, g);
    this.sweep(this.swarm, g);
    for (const eid of this.swarmKeys.keys()) if (!this.swarm.has(eid)) this.swarmKeys.delete(eid);
    this.iconCount = n;
  }

  private apply<K>(map: Map<K, IconRec>, key: K, sprite: Container, radius: number, scale: number, colour: number, g: number): boolean {
    let rec = map.get(key);
    if (!rec) {
      const icon = new Sprite(farIconTexture());
      icon.anchor.set(0.5);
      icon.visible = false;
      this.container.addChild(icon);
      rec = { icon, iconOnly: false, gen: g };
      map.set(key, rec);
    }
    rec.gen = g;
    const icon = rec.icon;
    const diam = 2 * radius * scale;
    const onlyNow = isIconOnly(diam, rec.iconOnly);
    if (onlyNow !== rec.iconOnly) {
      rec.iconOnly = onlyNow;
      if (!onlyNow) sprite.renderable = true;
    }
    // Every frame: an art swap can replace the sprite object.
    if (onlyNow) sprite.renderable = false;
    // A hidden sprite (e.g. mid warp run) hides its icon too.
    const alpha = sprite.visible ? (onlyNow ? 1 : farIconAlpha(diam)) : 0;
    if (alpha <= 0) {
      icon.visible = false;
      return false;
    }
    icon.visible = true;
    icon.alpha = alpha;
    icon.tint = colour;
    icon.position.set(sprite.x, sprite.y);
    icon.rotation = sprite.rotation;
    icon.scale.set(FAR_ICON.sizePx / (icon.texture.width * scale));
    return onlyNow;
  }

  private sweep<K>(map: Map<K, IconRec>, g: number): void {
    for (const [k, rec] of map) {
      if (rec.gen === g) continue;
      rec.icon.destroy();
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
