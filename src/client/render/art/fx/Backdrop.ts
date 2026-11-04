/**
 * The new backdrop (plan iridescent-seeking-rainbow v3, B2): baked star
 * tiles, a per-sector nebula, a few bright stars and distant galaxies, the sun
 * in the direction the hulls are lit from, and (high quality only) dust
 * streaming past in front of the world.
 *
 * Every layer is a texture made once (art/fx/fxTextures.ts via
 * `ArtService.fx`) and only moved and scaled per frame: depth is
 * `backdropXf` (far layers pan and grow less than near ones), so zooming
 * feels like moving through space. Until the star tiles are baked, `update`
 * returns false and the caller keeps drawing today's starfield.
 *
 * Per frame: scalar writes on pre-built sprites only (invariant #14).
 */
import { Container, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { hashStr } from '../raster.js';
import { backdropXf, zoomWindow, type TileXf } from './fxMath.js';

export interface BackdropCamera {
  readonly center: { x: number; y: number };
  readonly scale: { x: number };
  readonly screenWidth: number;
  readonly screenHeight: number;
}

/** Which nebula a sector gets, from its key (stable between visits). */
export interface SectorNebula { variant: 'emission' | 'reflection' | 'dark'; seed: number; alpha: number }

const NEBULA_VARIANTS = ['emission', 'reflection', 'dark'] as const;
/** Layer strength by type. The red-pink emission one is kept faint (user pick).
 *  A dark-dust sector is a faint blue glow crossed by dark lanes: dust only
 *  reads as dark against something bright behind it. */
const NEBULA_ALPHA: Record<SectorNebula['variant'], number> = { emission: 0.48, reflection: 0.72, dark: 0.4 };
const LANES_ALPHA: Record<SectorNebula['variant'], number> = { emission: 0.55, reflection: 0, dark: 0.8 };

export function sectorNebula(sectorKey: string | null): SectorNebula {
  const h = hashStr(`nebula:${sectorKey ?? 'none'}`);
  const variant = NEBULA_VARIANTS[h % NEBULA_VARIANTS.length]!;
  // Seeds are kept small and few, so most sectors share cached textures.
  return { variant, seed: 1 + ((h >>> 8) % 12), alpha: NEBULA_ALPHA[variant] };
}

interface Tile {
  s: TilingSprite; h: ArtHandle | null;
  parallax: number; zoomPow: number; texScale: number; alpha: number;
  win: [number, number, number, number] | null;
}

interface SkySprite { s: Sprite; h: ArtHandle; lx: number; ly: number; parallax: number; zoomPow: number; size: number; alpha: number; twinkle: boolean }

export class Backdrop {
  /** Behind the world. */
  readonly sky = new Container();
  /** In front of the world (dust). */
  readonly fore = new Container();
  private readonly tiles: Tile[] = [];
  private readonly sprites: SkySprite[] = [];
  private readonly nebula: Tile;
  private readonly far: Tile;
  private readonly lanes: Tile;
  private readonly dust: Tile;
  private readonly xf: TileXf = { scale: 1, x: 0, y: 0 };
  private nebulaFor = '\u0000';
  private t = 0;

  constructor(private readonly art: ArtService, private readonly getQuality: () => string) {
    this.sky.eventMode = 'none';
    this.fore.eventMode = 'none';
    this.fore.blendMode = 'add';
    this.nebula = this.tile(null, 0.012, 0.08, 2.6, 0.6, 'add', this.sky, null);
    this.far = this.tile(art.fx('starsFar', undefined, undefined, false), 0.02, 0.1, 1, 0.95, 'add', this.sky, null);
    for (const [lx, ly, size] of [[-260, -140, 46], [330, 210, 30], [80, -300, 22]] as const) {
      this.sprite(art.fx('galaxy', undefined, undefined, false), lx, ly, 0.015, 0.06, size, 0.5, false);
    }
    // The sun sits far out along the light direction, so it agrees with the hulls.
    const az = art.lightRig.sunAz;
    this.sprite(art.fx('sun', undefined, undefined, false), Math.cos(az) * 700, Math.sin(az) * 700, 0.004, 0.03, 520, 0.95, false).s.tint = 0xfff0d8;
    this.tile(art.fx('starsMid', undefined, undefined, false), 0.045, 0.22, 1, 0.9, 'add', this.sky, null);
    // Dark lanes sit in front of the far stars and the glow, hiding them.
    this.lanes = this.tile(null, 0.03, 0.15, 2.2, 0.55, 'normal', this.sky, null);
    for (let i = 0; i < 7; i++) {
      const sp = this.sprite(art.fx('spikeStar', undefined, undefined, false), (((i * 0.37) % 1) - 0.5) * 2000, (((i * 0.61) % 1) - 0.5) * 1200, 0.05, 0.2, 26 + (i % 3) * 10, 0.9, true);
      sp.s.tint = i % 3 ? 0xdfe8ff : 0xffe2c0;
    }
    this.tile(art.fx('starsNear', undefined, undefined, false), 0.085, 0.35, 1, 0.9, 'add', this.sky, [0.22, 0.45, Infinity, Infinity]);
    this.dust = this.tile(art.fx('dust', undefined, undefined, false), 1.25, 1.0, 1, 0.3, 'add', this.fore, [0.3, 0.6, Infinity, Infinity]);
    this.setSector(null);
  }

  /** The sector changed: pick its nebula (baked on first visit, cached after). */
  setSector(sectorKey: string | null): void {
    const key = sectorKey ?? '';
    if (key === this.nebulaFor) return;
    this.nebulaFor = key;
    const n = sectorNebula(sectorKey);
    this.nebula.h = this.art.fx('nebula', n.variant === 'dark' ? 'reflection' : n.variant, n.seed);
    this.nebula.alpha = n.alpha;
    this.nebula.s.visible = false;
    const lanes = LANES_ALPHA[n.variant];
    this.lanes.h = lanes > 0 ? this.art.fx('nebula', 'dark', n.seed + 40) : null;
    this.lanes.alpha = lanes;
    this.lanes.s.visible = false;
  }

  /** Which nebula texture is on (variant:seed), or null before it's chosen. */
  nebulaKey(): string | null {
    const j = this.nebula.h?.job;
    return j && j.type === 'fx' ? `${j.variant ?? ''}:${j.seed ?? ''}` : null;
  }

  /** Lay the backdrop out for this frame. False while the star tiles are
   *  still baking (the caller draws today's starfield instead). */
  update(cam: BackdropCamera, nowMs: number): boolean {
    if (this.far.h?.state !== 'ready') { this.sky.visible = false; this.fore.visible = false; return false; }
    this.sky.visible = true;
    this.t = nowMs / 1000;
    const zoom = cam.scale.x, W = cam.screenWidth, H = cam.screenHeight;
    const cx = cam.center.x, cy = cam.center.y;
    const dust = this.getQuality() === 'high';
    this.fore.visible = dust;
    for (let i = 0; i < this.tiles.length; i++) {
      const tl = this.tiles[i]!;
      if (tl === this.dust && !dust) continue;
      const tex = readyTex(tl.h);
      if (!tex) { tl.s.visible = false; continue; }
      if (tl.s.texture !== tex) tl.s.texture = tex;
      tl.s.visible = true;
      if (tl.s.width !== W) tl.s.width = W;
      if (tl.s.height !== H) tl.s.height = H;
      backdropXf(cx, cy, zoom, tl.parallax, tl.zoomPow, W, H, this.xf);
      tl.s.tileScale.set(this.xf.scale * tl.texScale);
      tl.s.tilePosition.set(this.xf.x, this.xf.y);
      tl.s.alpha = tl.alpha * (tl.win ? zoomWindow(zoom, tl.win[0], tl.win[1], tl.win[2], tl.win[3]) : 1);
    }
    for (let i = 0; i < this.sprites.length; i++) {
      const ss = this.sprites[i]!;
      const tex = readyTex(ss.h);
      if (!tex) { ss.s.visible = false; continue; }
      if (ss.s.texture !== tex) ss.s.texture = tex;
      ss.s.visible = true;
      backdropXf(cx, cy, zoom, ss.parallax, ss.zoomPow, W, H, this.xf);
      ss.s.position.set(this.xf.x + ss.lx * this.xf.scale, this.xf.y + ss.ly * this.xf.scale);
      ss.s.scale.set((ss.size * this.xf.scale) / tex.width);
      ss.s.alpha = ss.alpha * (ss.twinkle ? 0.75 + 0.25 * Math.sin(this.t * (1.3 + i * 0.37) + i * 2.1) : 1);
    }
    return true;
  }

  destroy(): void {
    this.sky.destroy({ children: true });
    this.fore.destroy({ children: true });
  }

  private tile(h: ArtHandle | null, parallax: number, zoomPow: number, texScale: number, alpha: number,
    blend: 'add' | 'normal', parent: Container, win: [number, number, number, number] | null): Tile {
    const s = new TilingSprite({ width: 1, height: 1 });
    s.blendMode = blend;
    s.visible = false;
    parent.addChild(s);
    const t: Tile = { s, h, parallax, zoomPow, texScale, alpha, win };
    this.tiles.push(t);
    return t;
  }

  private sprite(h: ArtHandle, lx: number, ly: number, parallax: number, zoomPow: number, size: number, alpha: number, twinkle: boolean): SkySprite {
    const s = new Sprite();
    s.anchor.set(0.5);
    s.blendMode = 'add';
    s.visible = false;
    this.sky.addChild(s);
    const ss: SkySprite = { s, h, lx, ly, parallax, zoomPow, size, alpha, twinkle };
    this.sprites.push(ss);
    return ss;
  }
}

function readyTex(h: ArtHandle | null): Texture | null {
  return h && h.state === 'ready' && h.fx ? h.fx.tex : null;
}
