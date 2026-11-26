/**
 * Junction sign boards (`?signs=on`, default off): an on-demand LED / holo
 * board over a road junction of a deck base. Not a floor object: when the
 * local ship comes within {@link SIGN_OPEN_RADIUS} of a junction that is on
 * screen, ONE board for it expands in (a short scale + alpha tween on the
 * game-time effects clock); past {@link SIGN_CLOSE_RADIUS} (or off screen) it
 * collapses and is gone. It draws above the bodies (a world-container child
 * added after the hulls) and is counter-scaled by `1/camera.scale` like
 * `LevelUpIcons`, so it reads the same size at any zoom.
 *
 * Content: one row per road arm leaving the junction, an arrow pointing ALONG
 * that arm (in the colour of its nearest place) and the nearest places down
 * that road (name + colour swatch: the kind's catalogue `displayName` and
 * `color`), from the road walk (`roadReach.ts`). The junctions themselves come
 * from the road-join rebuild's cache (`roadJoins.ts` `JUNCTIONS`).
 *
 * Per frame (invariant #14, no allocation): a linear nearest-junction scan
 * against the local ship, the view check and the tween. Only while a board is
 * open: one fold over the structure rows (ids + positions) and the junction
 * cache epoch; a change rebuilds the content (cold: the walk, `Text` writes).
 */
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '@core/contracts/IRenderer';
import { DECK_HEX_FLAT, DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import type { Camera } from '../worker/Camera.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';
import { JUNCTIONS, mix } from './roadJoins.js';
import { SIGN_PLACES_PER_ARM, walkJunctionArms, type ArmSign, type SignSite } from './roadReach.js';

/** `?signs=on` turns the boards on (look R&D, default off). */
export function readSignsFlag(search: string): boolean {
  return /[?&]signs=on\b/.test(search);
}

/** A junction this close to the local ship (game units, ~1¼ deck hexes) opens its board. */
export const SIGN_OPEN_RADIUS = 1.25 * DECK_HEX_FLAT;
/** An open board collapses past this distance (hysteresis: > open). */
export const SIGN_CLOSE_RADIUS = 2 * DECK_HEX_FLAT;
/** Expand / collapse time, game ms. */
export const SIGN_TWEEN_MS = 180;

const ROWS_MAX = 6;
/** Board metrics, screen px (sized to read on a phone held sideways). */
const FONT_PX = 17;
const ROW_H = 28;
const PAD = 10;
const ARROW_W = 26;
const SWATCH = 12;
const GAP = 14;
/** Screen px between the junction centre and the board's bottom edge. */
const LIFT = 26;
/** The board stays inside the view inset by these fractions (left, top,
 *  right, bottom): clear of the HUD corners, the right rail and the bottom
 *  bars. A junction near an edge keeps its board inboard, tied by the stem. */
export const SIGN_SAFE_INSET = [0.17, 0.17, 0.17, 0.26] as const;
const STEM_PX = 1.5;
const PIN_PX = 4;
const PANEL_FILL = 0x04101a;
const LED = 0x6ff4ff;

let style: TextStyle | null = null;
function ledStyle(): TextStyle {
  style ??= new TextStyle({ fontFamily: 'monospace', fontSize: FONT_PX, fontWeight: 'bold', fill: LED, letterSpacing: 1 });
  return style;
}

// Content signature fold (module scratch: no closure per frame).
let foldAcc = 0;
let foldSwarm: ReadonlyMap<number, SwarmRenderState> | undefined;
function foldSite(_st: StructureRenderState, id: number): void {
  const a = foldSwarm!.get(id);
  foldAcc = a === undefined ? mix(foldAcc, id) : mix(mix(mix(foldAcc, id), Math.round(a.x)), Math.round(a.y));
}

/** Ease-out cubic, 0..1. */
function ease(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export class DeckSignBoard {
  private readonly root = new Container();
  /** Counter-scaled board, origin at its bottom-centre. */
  private readonly board = new Container();
  private readonly body = new Container();
  /** Unit-length line from the junction to the board (scaled per frame). */
  private readonly stem = new Graphics();
  /** Dot on the junction itself. */
  private readonly pin = new Graphics();
  private boardW = 0;
  private boardH = 0;
  private readonly panel = new Graphics();
  private readonly glyphs = new Graphics();
  /** Place names, created when a board first needs them (cold), reused. */
  private readonly texts: Text[] = [];
  /** The junction whose content is built (index into `JUNCTIONS`), -1 none. */
  private shown = -1;
  private shownQ = 0;
  private shownR = 0;
  private shownEpoch = -1;
  private shownSig = 0;
  /** The built board has no rows (nothing down any road): stays hidden. */
  private empty = true;
  /** Tween 0 (gone) .. 1 (open). */
  private t = 0;
  private lastMs = Number.NaN;
  /** Rows on the built board. */
  private rows = 0;

  constructor(world: Container, private readonly camera: Camera, readonly enabled: boolean) {
    this.root.visible = false;
    this.root.label = 'deckSignBoard';
    this.body.addChild(this.panel, this.glyphs);
    this.board.addChild(this.body);
    this.stem.rect(0, -0.5, 1, 1).fill({ color: LED, alpha: 0.7 });
    this.pin.circle(0, 0, PIN_PX).fill({ color: LED, alpha: 0.9 });
    this.root.addChild(this.stem, this.pin, this.board);
    world.addChild(this.root);
  }

  /** Per frame. `nowMs`: the effects clock (game time); `bounds`: this
   *  frame's visible rect (`Camera.visibleBoundsInto`, Pixi space). */
  update(mirror: RenderMirror, spectator: boolean, nowMs: number, bounds: Float64Array | undefined): void {
    if (!this.enabled) return;
    const dt = Number.isNaN(this.lastMs) ? 0 : Math.min(100, Math.max(0, nowMs - this.lastMs));
    this.lastMs = nowMs;
    this.relocateAfterRebuild();
    const ship = spectator || mirror.deckPlates?.deck !== true || mirror.localPlayerId === null ? undefined : mirror.ships.get(mirror.localPlayerId);
    const want = ship === undefined ? -1 : this.pick(ship.x, ship.y, bounds);
    const step = dt / SIGN_TWEEN_MS;
    if (want !== this.shown) {
      if (this.t > 0) this.t = Math.max(0, this.t - step); // collapse the old board first
      else if (want >= 0) this.build(want, mirror);
      else this.shown = -1;
    } else if (want >= 0) {
      if (this.contentSig(mirror) !== this.shownSig || JUNCTIONS.epoch !== this.shownEpoch) this.build(want, mirror);
      this.t = Math.min(1, this.t + step);
    }
    if (this.t <= 0 || this.shown < 0 || this.empty) { this.root.visible = false; return; }
    const e = ease(this.t);
    const inv = this.camera.scale.x > 0 ? 1 / this.camera.scale.x : 1;
    this.root.visible = true;
    this.root.alpha = e;
    const k = inv * (0.5 + 0.5 * e);
    this.board.scale.set(k);
    const jx = JUNCTIONS.x[this.shown]!, jy = -JUNCTIONS.y[this.shown]!; // game y up → Pixi y down
    this.pin.x = jx; this.pin.y = jy; this.pin.scale.set(inv);
    // Board: centred above the junction, then clamped into the safe rect.
    const w = this.boardW * k, h = this.boardH * k;
    let bx = jx, by = jy - LIFT * inv; // bottom-centre
    if (bounds !== undefined) {
      const vw = bounds[2]! - bounds[0]!, vh = bounds[3]! - bounds[1]!;
      bx = clampSpan(bx, bounds[0]! + vw * SIGN_SAFE_INSET[0] + w / 2, bounds[2]! - vw * SIGN_SAFE_INSET[2] - w / 2);
      by = clampSpan(by, bounds[1]! + vh * SIGN_SAFE_INSET[1] + h, bounds[3]! - vh * SIGN_SAFE_INSET[3]);
    }
    this.board.x = bx; this.board.y = by;
    // Stem: junction → the nearest point of the board's rect.
    const ex = Math.min(Math.max(jx, bx - w / 2), bx + w / 2), ey = Math.min(Math.max(jy, by - h), by);
    const dx = ex - jx, dy = ey - jy, len = Math.hypot(dx, dy);
    this.stem.visible = len > 0;
    this.stem.x = jx; this.stem.y = jy;
    this.stem.rotation = Math.atan2(dy, dx);
    this.stem.scale.set(len, STEM_PX * inv);
  }

  /** Board placement in Pixi space (test hook): bottom-centre x, y. */
  boardAnchor(): { x: number; y: number } {
    return { x: this.board.x, y: this.board.y };
  }

  /** Visible junction rows (test hook). */
  rowCount(): number {
    return this.shown < 0 || this.empty ? 0 : this.rows;
  }

  /** Current tween 0..1 (test hook). */
  openness(): number {
    return this.t;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.texts.length = 0;
  }


  /** The road-join rebuild renumbers the cache: find the shown junction again by hex. */
  private relocateAfterRebuild(): void {
    if (this.shown < 0 || JUNCTIONS.epoch === this.shownEpoch) return;
    let found = -1;
    for (let i = 0; i < JUNCTIONS.count; i++) if (JUNCTIONS.q[i] === this.shownQ && JUNCTIONS.r[i] === this.shownR) { found = i; break; }
    if (found < 0) { this.shown = -1; this.t = 0; } else this.shown = found;
  }

  /** The junction the board should show: the open one while within the close
   *  radius and on screen, else the nearest on-screen one within the open radius. */
  private pick(sx: number, sy: number, bounds: Float64Array | undefined): number {
    const cur = this.shown;
    if (cur >= 0 && cur < JUNCTIONS.count && this.inReach(cur, sx, sy, SIGN_CLOSE_RADIUS, bounds)) return cur;
    let best = -1, bestD2 = SIGN_OPEN_RADIUS * SIGN_OPEN_RADIUS;
    for (let i = 0; i < JUNCTIONS.count; i++) {
      const dx = JUNCTIONS.x[i]! - sx, dy = JUNCTIONS.y[i]! - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2 && isSpriteInView(JUNCTIONS.x[i]!, -JUNCTIONS.y[i]!, DECK_HEX_SIZE, bounds)) { best = i; bestD2 = d2; }
    }
    return best;
  }

  private inReach(i: number, sx: number, sy: number, radius: number, bounds: Float64Array | undefined): boolean {
    const dx = JUNCTIONS.x[i]! - sx, dy = JUNCTIONS.y[i]! - sy;
    return dx * dx + dy * dy < radius * radius && isSpriteInView(JUNCTIONS.x[i]!, -JUNCTIONS.y[i]!, DECK_HEX_SIZE, bounds);
  }

  private contentSig(mirror: RenderMirror): number {
    if (mirror.structures === undefined || mirror.swarm === undefined) return 0;
    foldAcc = 2166136261;
    foldSwarm = mirror.swarm;
    mirror.structures.forEach(foldSite);
    foldSwarm = undefined;
    return foldAcc;
  }

  /** Cold: walk the junction's roads and lay the board out. */
  private build(i: number, mirror: RenderMirror): void {
    this.shown = i;
    this.shownQ = JUNCTIONS.q[i]!;
    this.shownR = JUNCTIONS.r[i]!;
    this.shownEpoch = JUNCTIONS.epoch;
    this.shownSig = this.contentSig(mirror);
    const sites: SignSite[] = [];
    const swarm = mirror.swarm;
    mirror.structures?.forEach((_st, id) => {
      const a = swarm?.get(id);
      if (a?.shipKind !== undefined) sites.push({ kind: a.shipKind, x: a.x, y: a.y });
    });
    const arms = walkJunctionArms(this.shownQ, this.shownR, JUNCTIONS.roadHexes, sites);
    this.layout(arms);
  }

  private layout(arms: readonly ArmSign[]): void {
    const g = this.glyphs;
    g.clear();
    let row = 0, width = 0, used = 0;
    for (const arm of arms) {
      if (arm.places.length === 0 || row >= ROWS_MAX) continue;
      const cy = PAD + row * ROW_H + ROW_H / 2;
      drawArrow(g, PAD + ARROW_W / 2, cy, arm.dir, arm.places[0]!.color);
      let x = PAD + ARROW_W + 8;
      for (let p = 0; p < arm.places.length && p < SIGN_PLACES_PER_ARM; p++) {
        const place = arm.places[p]!;
        if (p > 0) x += GAP;
        g.rect(x, cy - SWATCH / 2, SWATCH, SWATCH).fill({ color: place.color });
        x += SWATCH + 6;
        const text = this.textAt(used++);
        const label = place.name.toUpperCase();
        if (text.text !== label) text.text = label;
        text.visible = true;
        text.x = x;
        text.y = cy;
        x += text.width;
      }
      width = Math.max(width, x + PAD);
      row++;
    }
    for (let k = used; k < this.texts.length; k++) this.texts[k]!.visible = false;
    this.rows = row;
    this.empty = row === 0;
    const h = PAD * 2 + row * ROW_H;
    this.panel.clear();
    if (!this.empty) {
      this.panel.roundRect(-2, -2, width + 4, h + 4, 7).stroke({ color: LED, alpha: 0.18, width: 4 }); // glow
      this.panel.roundRect(0, 0, width, h, 5).fill({ color: PANEL_FILL, alpha: 0.86 }).stroke({ color: LED, alpha: 0.8, width: 1.5 });
    }
    this.boardW = width;
    this.boardH = h;
    this.body.x = -width / 2;
    this.body.y = -h;
  }

  private textAt(k: number): Text {
    let t = this.texts[k];
    if (t === undefined) {
      t = new Text({ text: '', style: ledStyle() });
      t.anchor.set(0, 0.5);
      this.texts.push(t);
      this.body.addChild(t);
    }
    return t;
  }
}

/** An arrow at (cx, cy) pointing along world direction `dir` (game angle
 *  60°·dir, drawn in Pixi's y-down frame). */
function drawArrow(g: Graphics, cx: number, cy: number, dir: number, color: number): void {
  const a = (-dir * Math.PI) / 3;
  const ux = Math.cos(a), uy = Math.sin(a);
  const len = ARROW_W / 2 - 1;
  const head = ARROW_W * 0.3, half = ARROW_W * 0.24;
  const tx = cx + ux * len, ty = cy + uy * len;
  g.moveTo(cx - ux * len, cy - uy * len).lineTo(tx, ty).stroke({ color, width: 3 });
  const hx = -ux * head, hy = -uy * head, px = -uy * half, py = ux * half;
  g.poly([tx, ty, tx + hx + px, ty + hy + py, tx + hx - px, ty + hy - py]).fill({ color });
}

/** `v` clamped to [lo, hi]; the middle when the span is too small. */
function clampSpan(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi);
}
