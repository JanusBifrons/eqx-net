/**
 * Base platforms — runway approach lights outside every deck fence gate
 * (owner: "just off the end of a runway where there's blinking lights that
 * sort of guide you in"). Part of the deck floor layer: {@link StructureDeckPlates}
 * owns one of these (like the zone paint, `structureDeckZones.ts`); not a
 * layer of its own. On by default (owner OK); `?approach=off` hides them.
 *
 * A gate (`shield_gate`) stands on a hex seam's midpoint, turned along the
 * seam (`deckGateRoad.ts`): the road through it (if any; roads are optional)
 * runs along the gate's local ±y. The lamps run in a straight line down that road on the OUTSIDE of the
 * fence (the seam side whose hex is on no deck plate), {@link APPROACH_LAMP_COUNT}
 * lamps {@link APPROACH_LAMP_SPACING} apart from {@link APPROACH_LAMP_START}
 * off the seam. A white "rabbit" strobe walks lamp by lamp TOWARD the gate
 * every {@link APPROACH_PERIOD_MS} of effect time (`fxNow`, invariant 20);
 * between pulses each lamp is a steady white lamp. Two edge rows flank the
 * centre line on the road's exact edges (shorter than it, like an airfield's side lights), in navigation colours for a ship
 * flying IN: red to port (its left), green to starboard (owner: "red and green
 * for starboard and port"). A gate with plates on
 * both sides of its seam (or neither) has no outside and gets no lamps.
 *
 * Each lamp is a light, not a disc (owner 2026-11-27, "Small lamps + soft
 * glow"): a hot core and a soft glow, both the shared effect `glow` texture
 * (the art service's; `WarpFx`'s canvas glow until it is baked or under
 * classic art), additive. Its on-screen size is capped
 * ({@link approachLampScale}): zoomed in it stays a few CSS px; zoomed out it
 * shrinks with the world. The strobe brightens and swells the lamp briefly.
 *
 * Static geometry (a Container per gate, a Container of glow + core Sprites
 * per lamp) is built when a gate appears and re-placed only when its pose or
 * the plate set changes; a frame writes only the on-screen gates' lamp scale
 * (when the zoom changed) and strobe (invariant #14).
 */
import { Container, Sprite, Texture } from 'pixi.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { DECK_FENCE_GATE_KIND } from '../../../core/structures/deckLinks.js';
import type { ArtHandle } from '../art/ArtService.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';
import { glowTexture } from './WarpFx.js';

/** `?approach=on|off` — default on (owner OK); `?approach=off` hides them. */
export function readApproachFlag(search: string): boolean {
  return !/[?&]approach=off\b/.test(search);
}

/** Centre (white) row: longer than the edge rows, so it reaches out and draws you in. */
export const APPROACH_LAMP_COUNT = 10;
/** Edge (red/green) rows: the first lamps of the centre row's positions, nearest the gate. */
export const APPROACH_EDGE_COUNT = 5;
/** World units between lamps, and from the seam to the first lamp. */
export const APPROACH_LAMP_SPACING = 135;
export const APPROACH_LAMP_START = 140;
/** One rabbit run, start to start (ms of effect time). */
export const APPROACH_PERIOD_MS = 1500;
/** Delay between one lamp's flash and the next lamp's (toward the gate). */
export const APPROACH_STEP_MS = 110;
/** How long one lamp's flash takes to fade out. */
export const APPROACH_FLASH_MS = 170;

/** zIndex: over the road tiles (`ROAD_UNDER_Z` −1.0625), under the rig pads
 *  (`RIG_UNDER_Z` −1) and every body. */
export const APPROACH_LAMP_Z = -1.03125;

/** Lamp size: the core's radius in world units (today's lens) — what it
 *  draws at zoom ≤ {@link LAMP_CAP_PX} / {@link LAMP_CORE_R} (the build and
 *  spawn cameras); past that it holds {@link LAMP_CAP_PX} CSS px. */
export const LAMP_CORE_R = 11;
export const LAMP_CAP_PX = 4;
/** The glow's reach, × the core radius (a soft fade, no edge). */
export const LAMP_GLOW_K = 3.5;
/** Glow strength between flashes (the core is at full). */
export const LAMP_GLOW_ALPHA = 0.55;
/** At a full flash the glow grows by this × and the core by half of it. */
export const LAMP_FLASH_GROW = 1.2;
/** Centre line: white, like a runway centreline (owner 2026-11-26). */
export const LAMP_CENTRE = 0xeef2ff;
/** Edge rows: lateral offset from the centre line (world units) = the road's carriageway edge
 *  (`ROAD_HALF_W`, a number here: the road art imports the deck plates; a test locks them equal),
 *  inside the gate's towers (416 wide). Then colours. */
export const APPROACH_EDGE_OFFSET = 175;
export const LAMP_PORT = 0xff3b30;
export const LAMP_STARBOARD = 0x30ff6a;

/**
 * Edge lamp beside lamp position (lx, ly) (game) of a gate turned `angleRad`
 * whose outside is `sign`: port (`port` true, the inbound pilot's left) or
 * starboard, written into `out` as [x, y]. Inbound heading is −sign × the
 * road axis (−sin a, cos a); its left is sign × (cos a, sin a).
 */
export function approachEdgeInto(lx: number, ly: number, angleRad: number, sign: number, port: boolean, out: Float64Array): Float64Array {
  const d = (port ? 1 : -1) * sign * APPROACH_EDGE_OFFSET;
  out[0] = lx + Math.cos(angleRad) * d;
  out[1] = ly + Math.sin(angleRad) * d;
  return out;
}

/**
 * Which side of the gate's seam is outside: +1 = the gate's local +y (game
 * frame), −1 = local −y, 0 = none (both hexes on a plate, or neither).
 * `onPlate(x, y)` answers whether the deck hex containing (x, y) is plated.
 */
export function gateOutsideSign(gx: number, gy: number, angleRad: number, onPlate: (x: number, y: number) => boolean): -1 | 0 | 1 {
  const nx = -Math.sin(angleRad) * DECK_HEX_INRADIUS, ny = Math.cos(angleRad) * DECK_HEX_INRADIUS;
  const plus = onPlate(gx + nx, gy + ny), minus = onPlate(gx - nx, gy - ny);
  if (plus === minus) return 0;
  return plus ? -1 : 1;
}

/**
 * Lamp `k` (0 = nearest the gate) of a gate at game pose (gx, gy, angle) whose
 * outside is `sign`: its GAME position, written into `out` as [x, y].
 */
export function approachLampInto(gx: number, gy: number, angleRad: number, sign: number, k: number, out: Float64Array): Float64Array {
  const d = sign * (APPROACH_LAMP_START + k * APPROACH_LAMP_SPACING);
  out[0] = gx - Math.sin(angleRad) * d;
  out[1] = gy + Math.cos(angleRad) * d;
  return out;
}

/**
 * The rabbit's flash on lamp `k` (0 = nearest the gate) of `count` at effect
 * time `nowMs`: 0..1. The run starts at the FARTHEST lamp and steps toward the
 * gate; each flash snaps on and fades over {@link APPROACH_FLASH_MS}.
 */
export function approachFlash(k: number, count: number, nowMs: number): number {
  const phase = ((nowMs % APPROACH_PERIOD_MS) + APPROACH_PERIOD_MS) % APPROACH_PERIOD_MS;
  const dt = phase - (count - 1 - k) * APPROACH_STEP_MS;
  if (!(dt >= 0) || dt >= APPROACH_FLASH_MS) return 0;
  const f = 1 - dt / APPROACH_FLASH_MS;
  return f * f;
}

/**
 * The lamp's scale at camera `zoom` (CSS px per world unit): 1 (its world
 * size) until its core would pass {@link LAMP_CAP_PX} on screen, then the
 * scale that holds it there. Absent or bad zoom ⇒ 1.
 */
export function approachLampScale(zoom: number): number {
  if (!(zoom > 0)) return 1;
  return Math.min(1, LAMP_CAP_PX / (LAMP_CORE_R * zoom));
}

/** Sprite radius (texture edge) in core radii: the `glow` texture's half-alpha
 *  sits near 0.3 of its radius, so a core sprite this big reads as one core. */
const CORE_TEX_K = 3.5;
/** The glow sprite's texture edge, in core radii (it fades out well inside). */
const GLOW_TEX_K = 2 * LAMP_GLOW_K;

/** `c` lifted toward white by `k` (0..1): a coloured lamp's hot centre. */
export function towardWhite(c: number, k: number): number {
  let out = 0;
  for (let s = 0; s <= 16; s += 8) { const v = (c >> s) & 0xff; out |= Math.round(v + (255 - v) * k) << s; }
  return out;
}
/** Core tints (the glow wears the lamp colour). */
export const CORE_TINT_PORT = towardWhite(LAMP_PORT, 0.45);
export const CORE_TINT_STAR = towardWhite(LAMP_STARBOARD, 0.45);

/** The lamp texture until the art `glow` is baked (or under classic art):
 *  `WarpFx`'s canvas glow; a white square where there is no canvas (unit tests). */
function fallbackGlow(): Texture {
  return glowTexture() ?? Texture.WHITE;
}

/** One lamp: glow (child 0, the lamp colour) under a hot core (child 1), additive. */
function makeLamp(tex: Texture, glow: number, core: number): Container {
  const lamp = new Container();
  for (let i = 0; i < 2; i++) {
    const s = new Sprite(tex);
    s.anchor.set(0.5);
    s.tint = i === 0 ? glow : core;
    s.blendMode = 'add';
    lamp.addChild(s);
  }
  return lamp;
}

/** Size `lamp`'s sprites for texture `tex` at flash `f` (0..1): the bloom
 *  swells the glow (and less so the core) and brings the glow to full. */
export function sizeApproachLamp(lamp: Container, tex: Texture, f: number): void {
  const unit = (2 * LAMP_CORE_R) / (tex.width || 1); // a texture radius ⇒ one core radius
  const glow = lamp.children[0]!, core = lamp.children[1]!;
  glow.scale.set(unit * GLOW_TEX_K * (1 + LAMP_FLASH_GROW * f));
  core.scale.set(unit * CORE_TEX_K * (1 + 0.5 * LAMP_FLASH_GROW * f));
  glow.alpha = LAMP_GLOW_ALPHA + (1 - LAMP_GLOW_ALPHA) * f;
}

/** What a frame reads besides the time: the camera scale and the art (the
 *  swarm updater's ctx fits; `DeckLitView`). */
export interface ApproachView {
  art: ShipArtCtx;
  cameraScale?: number;
}

/** Half the lamp line's length plus the glow: the cull radius round its middle. */
const CULL_R = ((APPROACH_LAMP_COUNT - 1) * APPROACH_LAMP_SPACING) / 2 + APPROACH_EDGE_OFFSET + 140;
const MID_D = APPROACH_LAMP_START + ((APPROACH_LAMP_COUNT - 1) * APPROACH_LAMP_SPACING) / 2;

/** Child index of the port (`port`) or starboard edge lamp beside centre lamp `k`. */
export function approachEdgeIndex(k: number, port: boolean): number {
  return APPROACH_LAMP_COUNT + 2 * k + (port ? 0 : 1);
}

interface GateEntry {
  c: Container;
  /** Each centre lamp's last drawn flash (0..1). */
  flash: Float64Array;
  /** The lamp scale and texture generation last applied. */
  scale: number;
  texGen: number;
  stamp: number;
  x: number; y: number; a: number;
  /** Plate version the side was worked out against. */
  plates: number;
  sign: number;
  /** Lamps lit per row: the run stops before the first lamp on a plate (another deck). */
  lit: number;
  /** Pixi centre of the lamp line (cull). */
  mx: number; my: number;
}

/**
 * The approach lights of every deck fence gate. The swarm updater notes each
 * structure ({@link note}); {@link frame} runs at the start of the next frame
 * (sweep gone gates, then size and strobe the live, on-screen ones).
 * Children of a gate's Container: centre lamps 0..{@link APPROACH_LAMP_COUNT}−1,
 * then a port + starboard lamp per edge position ({@link approachEdgeIndex}).
 */
export class DeckApproachLights {
  private readonly entries = new Map<number, GateEntry>();
  private stamp = 0;
  private deck = false;
  private plateVersion = 0;
  private readonly pt = new Float64Array(2);
  private nowMs = 0;
  private bounds: Float64Array | undefined;
  /** The lamp scale this frame ({@link approachLampScale}). */
  private scale = 1;
  /** The lamp texture: the fallback glow until the art `glow` is ready. */
  private tex: Texture = fallbackGlow();
  private texGen = 0;
  private glowHandle: ArtHandle | null = null;
  private readonly sweepFn = (e: GateEntry, id: number): void => {
    if (e.stamp !== this.stamp) this.drop(id, e);
  };
  private readonly strobeFn = (e: GateEntry): void => {
    e.c.visible = e.sign !== 0 && isSpriteInView(e.mx, e.my, CULL_R, this.bounds);
    if (!e.c.visible) return;
    const lamps = e.c.children;
    if (e.texGen !== this.texGen) this.retexture(e);
    if (e.scale !== this.scale) {
      e.scale = this.scale;
      for (let i = 0; i < lamps.length; i++) lamps[i]!.scale.set(this.scale);
    }
    for (let k = 0; k < e.lit; k++) {
      const f = approachFlash(k, e.lit, this.nowMs);
      if (f === e.flash[k]) continue;
      e.flash[k] = f;
      sizeApproachLamp(lamps[k] as Container, this.tex, f);
    }
  };

  /** `onPlate(x, y)`: is the deck hex at game (x, y) plated (the floor's set). */
  constructor(private readonly shipContainer: Container, private readonly onPlate: (x: number, y: number) => boolean) {}

  /** Live gates (tests, stats). */
  get size(): number { return this.entries.size; }

  /** The lamp Container of gate `id` (tests). */
  containerOf(id: number): Container | undefined { return this.entries.get(id)?.c; }

  /** Free gates not noted since the last call, size and strobe the rest at
   *  effect time `nowMs` (on-screen only: `bounds`, pixi space) and the
   *  `view`'s camera scale, then start a frame. */
  frame(deck: boolean, plateVersion: number, nowMs: number, bounds: Float64Array | undefined, view?: ApproachView): void {
    this.deck = deck;
    this.plateVersion = plateVersion;
    if (!deck) this.stamp++; // off the deck: everything goes now
    this.entries.forEach(this.sweepFn);
    this.nowMs = nowMs;
    this.bounds = bounds;
    this.scale = approachLampScale(view?.cameraScale ?? 1);
    if (this.entries.size > 0) this.pickTexture(view);
    this.entries.forEach(this.strobeFn);
    this.bounds = undefined;
    this.stamp++;
  }

  /** Structure `id` of kind `kindId` stands at game pose (x, y, angle) this frame. */
  note(id: number, kindId: string | undefined, x: number, y: number, angle: number): void {
    if (!this.deck) return;
    let e = this.entries.get(id);
    if (kindId !== DECK_FENCE_GATE_KIND) { if (e !== undefined) this.drop(id, e); return; } // recycled id
    if (e === undefined) e = this.build(id);
    e.stamp = this.stamp;
    if (e.x === x && e.y === y && e.a === angle && e.plates === this.plateVersion) return;
    e.x = x; e.y = y; e.a = angle; e.plates = this.plateVersion;
    e.sign = gateOutsideSign(x, y, angle, this.onPlate);
    e.lit = APPROACH_LAMP_COUNT;
    e.c.position.set(x, -y); // Y-flip
    const lamps = e.c.children;
    for (let k = 0; k < APPROACH_LAMP_COUNT; k++) {
      approachLampInto(0, 0, angle, e.sign, k, this.pt);
      if (e.lit === APPROACH_LAMP_COUNT && e.sign !== 0 && this.onPlate(x + this.pt[0]!, y + this.pt[1]!)) e.lit = k; // another deck: stop short
      const on = k < e.lit;
      lamps[k]!.visible = on;
      lamps[k]!.position.set(this.pt[0]!, -this.pt[1]!);
      if (k >= APPROACH_EDGE_COUNT) continue;
      const lx = this.pt[0]!, ly = this.pt[1]!;
      approachEdgeInto(lx, ly, angle, e.sign, true, this.pt);
      lamps[approachEdgeIndex(k, true)]!.position.set(this.pt[0]!, -this.pt[1]!);
      lamps[approachEdgeIndex(k, true)]!.visible = on;
      approachEdgeInto(lx, ly, angle, e.sign, false, this.pt);
      lamps[approachEdgeIndex(k, false)]!.position.set(this.pt[0]!, -this.pt[1]!);
      lamps[approachEdgeIndex(k, false)]!.visible = on;
    }
    e.mx = x - Math.sin(angle) * e.sign * MID_D;
    e.my = -(y + Math.cos(angle) * e.sign * MID_D);
  }

  destroy(): void {
    this.stamp++;
    this.entries.forEach(this.sweepFn);
  }

  /** Swap to the baked art `glow` once it is ready (once; the handle is reused). */
  private pickTexture(view: ApproachView | undefined): void {
    if (this.glowHandle?.state === 'ready' && this.glowHandle.fx?.tex === this.tex) return;
    const art = view?.art.art;
    if (!art) return;
    this.glowHandle ??= art.fx('glow', undefined, undefined, false);
    const fx = this.glowHandle.state === 'ready' ? this.glowHandle.fx : null;
    if (!fx || fx.tex === this.tex) return;
    this.tex = fx.tex;
    this.texGen++;
  }

  /** Put gate `e`'s lamps on the current texture, sized for it (flash reset). */
  private retexture(e: GateEntry): void {
    e.texGen = this.texGen;
    const lamps = e.c.children;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i] as Container;
      (lamp.children[0] as Sprite).texture = this.tex;
      (lamp.children[1] as Sprite).texture = this.tex;
      sizeApproachLamp(lamp, this.tex, 0);
    }
    e.flash.fill(0);
  }

  /** Build time: a gate's Container with a centre lamp per position, then a port + starboard edge lamp per edge position. */
  private build(id: number): GateEntry {
    const c = new Container();
    c.label = 'deckApproach';
    c.zIndex = APPROACH_LAMP_Z;
    for (let k = 0; k < APPROACH_LAMP_COUNT; k++) c.addChild(makeLamp(this.tex, LAMP_CENTRE, 0xffffff));
    for (let k = 0; k < APPROACH_EDGE_COUNT; k++) { // edge rows after the centre line
      c.addChild(makeLamp(this.tex, LAMP_PORT, CORE_TINT_PORT));
      c.addChild(makeLamp(this.tex, LAMP_STARBOARD, CORE_TINT_STAR));
    }
    this.shipContainer.sortableChildren = true;
    this.shipContainer.addChild(c);
    // texGen −1: the first on-screen frame sizes every lamp for the texture.
    const e: GateEntry = { c, flash: new Float64Array(APPROACH_LAMP_COUNT), scale: Number.NaN, texGen: -1, stamp: 0, x: Number.NaN, y: Number.NaN, a: Number.NaN, plates: -1, sign: 0, lit: APPROACH_LAMP_COUNT, mx: 0, my: 0 };
    this.entries.set(id, e);
    return e;
  }

  private drop(id: number, e: GateEntry): void {
    e.c.parent?.removeChild(e.c);
    e.c.destroy({ children: true }); // the shared textures survive
    this.entries.delete(id);
  }
}
