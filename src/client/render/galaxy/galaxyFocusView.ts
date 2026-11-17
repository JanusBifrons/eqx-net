import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { axialToPixel, getSector } from '@core/galaxy/galaxy';
import type { Camera } from '../worker/Camera';
import { hexFlat } from './galaxyHexDraw';
import { factionBorderColor, factionColor, mixColor } from './galaxyTerritories';
import {
  DOOR_SIZE,
  FOCUS_GLIDE_MS,
  FOCUS_IDLE,
  doorAt,
  focusFrame,
  focusPanelDock,
  focusPanelInsets,
  focusStep,
  focusTapResult,
  layoutDoors,
  type DoorSlot,
  type FocusEvent,
  type FocusFrame,
  type FocusState,
  type FocusTap,
} from './galaxyFocus';

/** Veil over the rest of the map while a sector is in focus (backdrop colour). */
const VEIL_COLOR = 0x05070d;
const VEIL_ALPHA = 0.74;
/** Veil fade rate (alpha per ms) — reaches full in about the glide time. */
const VEIL_RATE = VEIL_ALPHA / 450;
/** How far the veil reaches round the focused hex (map px; covers the cluster). */
const VEIL_REACH = 6000;
const DOOR_LABEL_FONT = 28;
const DOOR_LABEL_SCALE = 0.22;
const COLOR_DOOR_LABEL = 0xdffff0;
const COLOR_LINK = 0x8fe9c0;

interface DoorSprite { g: Graphics; label: Text }

/**
 * The Pixi side of the galaxy map FOCUS VIEW (decisions in `galaxyFocus.ts`).
 * Owned by `GalaxyMapLayer`: it drives the layer's existing pan/zoom `Camera`
 * with `glideTo` (centre + zoom), veils the rest of the map, and draws the
 * focused sector's linked neighbours as tappable door hexes. Everything is
 * redrawn on a focus change only; the per-frame `tick` just fades the veil
 * and watches for the glide to land, and does nothing at all while idle.
 */
export class GalaxyFocusView {
  private state: FocusState = FOCUS_IDLE;
  private doors: DoorSlot[] = [];
  private readonly doorSprites: DoorSprite[] = [];
  private readonly veil = new Graphics();
  private readonly doorLayer = new Container();
  private readonly flat: number[];
  private screenW = 0;
  private screenH = 0;
  private touch = false;

  constructor(
    private readonly camera: Camera,
    private readonly root: Container,
    private readonly hexR: number,
    private readonly reducedMotion: boolean,
    /** Live owner of a sector (the layer's `resolveSectorOwner`). */
    private readonly ownerOf: (key: string) => string,
  ) {
    this.flat = hexFlat(hexR * 1.04);
    this.veil.alpha = 0;
    this.veil.visible = false;
    this.doorLayer.visible = false;
    root.addChild(this.veil, this.doorLayer);
  }

  /** The focused sector (null when idle or backing out). */
  get key(): string | null {
    return this.state.key;
  }

  /** Open (or hop) the focus on `key`, or back out on null. */
  set(key: string | null, screenW: number, screenH: number, touch: boolean): void {
    this.screenW = screenW;
    this.screenH = screenH;
    this.touch = touch;
    if (key !== null && !getSector(key)) key = null;
    this.apply(key === null ? { type: 'close' } : { type: 'open', key, view: this.currentView() });
  }

  /** Drop the focus at once (the map hid). */
  reset(): void {
    if (this.state.phase === 'idle') return;
    this.camera.cancelGlide();
    this.state = FOCUS_IDLE;
    this.veil.alpha = 0;
    this.veil.visible = false;
    this.doorLayer.visible = false;
  }

  /** A pointer went down: a drag or pinch mid-glide stops the glide there. */
  onPointerDown(): void {
    if ((this.state.phase === 'in' || this.state.phase === 'out') && this.camera.isGliding()) {
      this.camera.cancelGlide();
      this.apply({ type: 'interrupt' });
    }
  }

  /** Resolve a confirmed tap (`hexKey` = the layer's own hit test). */
  tap(screenX: number, screenY: number, hexKey: string | null): FocusTap {
    let door: string | null = null;
    if (this.state.key !== null && this.doorLayer.visible) {
      const s = this.root.scale.x;
      if (s !== 0) door = doorAt(this.doors, (screenX - this.root.x) / s, (screenY - this.root.y) / s, this.hexR * DOOR_SIZE);
    }
    return focusTapResult(this.state.key, door, hexKey);
  }

  /** The screen changed size (the layer has just re-seeded its camera):
   *  that view is the new home, and the focus re-frames at once. */
  onResize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    if (this.state.key === null) return;
    this.state = { ...this.state, home: this.currentView() };
    this.glideToKey(1);
  }

  /** The feed changed owners: recolour the doors. */
  refresh(): void {
    if (this.state.key !== null) this.drawDoors(this.state.key);
  }

  /** Per frame (selector map only). Allocates nothing; idle does nothing. */
  tick(dtMs: number): void {
    const phase = this.state.phase;
    if (phase === 'idle') return;
    if ((phase === 'in' || phase === 'out') && !this.camera.isGliding()) this.apply({ type: 'arrived' });
    const want = this.state.key !== null ? VEIL_ALPHA : 0;
    const a = this.veil.alpha;
    const step = this.reducedMotion ? 1 : VEIL_RATE * dtMs;
    this.veil.alpha = want > a ? Math.min(want, a + step) : Math.max(want, a - step);
    this.doorLayer.alpha = this.veil.alpha / VEIL_ALPHA;
    if (this.state.phase === 'idle' && this.veil.alpha === 0) {
      this.veil.visible = false;
      this.doorLayer.visible = false;
    }
  }

  /** DEV/E2E: the focus phase, sector and door keys. */
  debug(): { phase: string; key: string | null; doors: string[] } {
    return { phase: this.state.phase, key: this.state.key, doors: this.doors.map((d) => d.key) };
  }

  private apply(e: FocusEvent): void {
    const { state, glide } = focusStep(this.state, e);
    this.state = state;
    if (glide === 'to-key' && state.key !== null) {
      this.drawFocus(state.key);
      this.glideToKey(this.reducedMotion ? 1 : FOCUS_GLIDE_MS);
    } else if (glide === 'home' && state.home !== null) {
      const h = state.home;
      this.camera.glideTo(h.cx, h.cy, this.reducedMotion ? 1 : FOCUS_GLIDE_MS, h.scale);
    }
  }

  private glideToKey(ms: number): void {
    const key = this.state.key;
    const sec = key !== null ? getSector(key) : undefined;
    if (!sec || this.screenW === 0 || this.screenH === 0) return;
    const p = axialToPixel(sec.hex, this.hexR);
    const insets = focusPanelInsets(focusPanelDock(this.screenH > this.screenW, this.touch), this.screenW, this.screenH);
    const f = focusFrame(p.x, p.y, this.hexR, this.doors, this.screenW, this.screenH, insets);
    this.camera.glideTo(f.cx, f.cy, ms, f.scale);
  }

  private currentView(): FocusFrame {
    const c = this.camera.center;
    return { scale: this.root.scale.x, cx: c.x, cy: c.y };
  }

  /** Veil with a hole for the focused hex, then its doors. */
  private drawFocus(key: string): void {
    const sec = getSector(key);
    if (!sec) return;
    const p = axialToPixel(sec.hex, this.hexR);
    const v = this.veil;
    v.clear();
    v.rect(p.x - VEIL_REACH, p.y - VEIL_REACH, VEIL_REACH * 2, VEIL_REACH * 2).fill(VEIL_COLOR);
    v.position.set(0, 0);
    const hole: number[] = [];
    for (let k = 0; k < this.flat.length; k += 2) hole.push(this.flat[k]! + p.x, this.flat[k + 1]! + p.y);
    v.poly(hole).cut();
    v.visible = true;
    this.drawDoors(key);
  }

  private drawDoors(key: string): void {
    const sec = getSector(key);
    if (!sec) return;
    const p = axialToPixel(sec.hex, this.hexR);
    const neighbours = [];
    for (const nk of sec.neighbours) {
      const ns = getSector(nk);
      if (ns) neighbours.push({ key: nk, ...axialToPixel(ns.hex, this.hexR) });
    }
    this.doors = layoutDoors(p.x, p.y, this.hexR, neighbours);
    const doorR = this.hexR * DOOR_SIZE;
    const doorFlat = hexFlat(doorR);
    for (let i = 0; i < this.doorSprites.length; i++) this.doorSprites[i]!.g.visible = this.doorSprites[i]!.label.visible = false;
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i]!;
      const sprite = this.doorSprite(i);
      const owner = this.ownerOf(d.key);
      const g = sprite.g;
      g.clear();
      // The link: from the focused hex's rim out to the door.
      const cos = Math.cos(d.angle);
      const sin = Math.sin(d.angle);
      const r0 = this.hexR * 0.9;
      const r1 = Math.hypot(d.x - p.x, d.y - p.y) - doorR;
      g.moveTo(p.x + cos * r0 - d.x, p.y + sin * r0 - d.y).lineTo(p.x + cos * r1 - d.x, p.y + sin * r1 - d.y)
        .stroke({ color: COLOR_LINK, width: 1.5, alpha: 0.7 });
      g.poly(doorFlat).fill(mixColor(VEIL_COLOR, factionColor(owner), 0.62)).stroke({ color: factionBorderColor(owner), width: 1.5 });
      // A chevron on the far side: this way to that sector.
      const tip = doorR * 1.32;
      const base = doorR * 1.08;
      const half = doorR * 0.22;
      g.poly([cos * tip, sin * tip, cos * base - sin * half, sin * base + cos * half, cos * base + sin * half, sin * base - cos * half])
        .fill(COLOR_LINK);
      g.position.set(d.x, d.y);
      g.visible = true;
      const label = sprite.label;
      label.text = getSector(d.key)?.name ?? d.key;
      label.position.set(d.x, d.y);
      label.visible = true;
    }
    this.doorLayer.visible = true;
  }

  private doorSprite(i: number): DoorSprite {
    let s = this.doorSprites[i];
    if (!s) {
      const g = new Graphics();
      const label = new Text({
        text: '',
        resolution: 2,
        roundPixels: true,
        style: new TextStyle({
          fontFamily: 'sans-serif', fontSize: DOOR_LABEL_FONT, fontWeight: '700', fill: COLOR_DOOR_LABEL,
          align: 'center', wordWrap: true, wordWrapWidth: (this.hexR * DOOR_SIZE * 1.6) / DOOR_LABEL_SCALE,
          lineHeight: DOOR_LABEL_FONT * 1.05,
        }),
      });
      label.anchor.set(0.5);
      label.scale.set(DOOR_LABEL_SCALE);
      this.doorLayer.addChild(g, label);
      s = { g, label };
      this.doorSprites.push(s);
    }
    return s;
  }
}
