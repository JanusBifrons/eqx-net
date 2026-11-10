/**
 * Incoming-fire warning (real-scale naval ranges): a 16" shell flies up to
 * ~30 s from a gun far off screen, so the target needs to see it coming.
 *
 * Each frame, for every naval shell in `mirror.projectiles` (the snapshot-
 * derived projectiles the client already has, #16; no event), predict its
 * closest approach to the local ship over its remaining flight
 * (`incomingFire.ts`). A shell passing within the danger radius
 * (`shipTuning.incomingFireRadius` + the gun's splash, #18) is grouped with
 * its salvo (one marker per fall area), and each group gets an in-world
 * marker: a red ring at the point where the shells cross near you, with a
 * countdown to the soonest arrival. The groups are also handed to the edge
 * radar (`HaloRadar.setIncoming`), which points at the shells themselves
 * when they are off screen.
 *
 * Renderer-side state only (never Zustand, #2). Screen-space container on the
 * stage (like the radar), so the ring and text keep a fixed pixel size at any
 * zoom. Pooled records and markers, generation-stamped sweep: no allocation
 * once warm (#14). Runs inside `PixiRenderer.update`, so the main-thread and
 * the worker render paths both draw it.
 */
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';
import { tuningFor } from '../../../shared-types/shipScale/lookup.js';
import type { Camera } from '../worker/Camera';
import {
  countdownLabel,
  groupShellPasses,
  isShellDangerous,
  makeFallGroup,
  predictShellPass,
  shellDangerRadius,
  shellRemainingS,
  type FallGroup,
  type ShellPass,
} from './incomingFire.js';

/** Shells considered per frame, and markers drawn. */
const MAX_SHELLS = 64;
const MAX_GROUPS = 8;
/** Shells arriving within this many seconds of each other share a marker
 *  (one salvo: the barrels and turrets of a broadside fire together). */
const JOIN_DT_S = 2;
/** Marker ring radius on screen: the danger radius, clamped. */
const RING_MIN_PX = 12;
const RING_MAX_PX = 320;
export const INCOMING_COLOR = 0xff4a3a;

interface ShellRec { sx: number; sy: number; maxTicks: number; splash: number; gen: number }

interface Marker { root: Container; ring: Graphics; text: Text; ringPx: number; label: string }

/** What the edge radar reads (see `HaloRadar.setIncoming`). */
export interface IncomingGroups {
  readonly groups: readonly FallGroup[];
  readonly groupCount: number;
}

/** Debug view of one drawn marker (tests / E2E). */
export interface IncomingMarkerDebug { x: number; y: number; ringPx: number; label: string; count: number }

let sharedStyle: TextStyle | null = null;
function labelStyle(): TextStyle {
  if (!sharedStyle) {
    sharedStyle = new TextStyle({
      fontFamily: '"JetBrains Mono", "Roboto Mono", monospace',
      fontSize: 10,
      fontWeight: '700',
      fill: '#ff6a5a',
      stroke: { color: '#000000', width: 2, join: 'round' },
    });
  }
  return sharedStyle;
}

export class IncomingFireWarning implements IncomingGroups {
  readonly container = new Container();
  private camera: Camera | null = null;
  private suppressed = false;

  private readonly shells = new Map<string, ShellRec>();
  private readonly free: ShellRec[] = [];
  private gen = 0;

  // ── scratch (#14) ──
  private readonly pass: ShellPass = { t: 0, miss: 0, x: 0, y: 0 };
  private readonly pt = { x: 0, y: 0 };
  private readonly fx = new Float64Array(MAX_SHELLS);
  private readonly fy = new Float64Array(MAX_SHELLS);
  private readonly sx = new Float64Array(MAX_SHELLS);
  private readonly sy = new Float64Array(MAX_SHELLS);
  private readonly ts = new Float64Array(MAX_SHELLS);
  private readonly rs = new Float64Array(MAX_SHELLS);
  readonly groups: FallGroup[] = [];
  groupCount = 0;
  private readonly markers: Marker[] = [];

  constructor() {
    this.container.eventMode = 'none';
    for (let i = 0; i < MAX_GROUPS; i++) this.groups.push(makeFallGroup());
  }

  /** Attach to the camera's parent (the stage): a screen-space layer. */
  init(camera: Camera): void {
    this.camera = camera;
    const stage = camera.parent;
    if (stage) stage.addChild(this.container);
  }

  /** In transit / arriving: the mirror holds the old sector, so no markers. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  update(mirror: RenderMirror, nowMs: number): void {
    const gen = ++this.gen;
    const localId = mirror.localPlayerId;
    const local = localId ? mirror.ships.get(localId) : undefined;
    const shipR = local ? tuningFor(local.kind).incomingFireRadius : 0;
    let n = 0;
    if (mirror.projectiles) for (const [id, p] of mirror.projectiles) {
      const w = p.weaponId;
      if (p.beam || w === undefined || !w.startsWith('naval_')) continue;
      let rec = this.shells.get(id);
      if (rec === undefined) {
        rec = this.free.pop() ?? { sx: 0, sy: 0, maxTicks: 0, splash: 0, gen: 0 };
        const def = isWeaponId(w) ? getWeapon(w) : null;
        rec.maxTicks = def && def.mode === 'projectile' ? def.maxTicks : 0;
        rec.splash = def && def.mode === 'projectile' && def.splash ? def.splash.radius : 0;
        rec.sx = p.x; rec.sy = p.y;
        this.shells.set(id, rec);
      }
      rec.gen = gen;
      // Own shots and dying (fading) entries never warn.
      if (!local || n >= MAX_SHELLS || p.isGhost || p.ownerId === localId) continue;
      if (p.alpha !== undefined && p.alpha < 1) continue;
      const speed = Math.hypot(p.vx, p.vy);
      const rem = shellRemainingS(rec.maxTicks, Math.hypot(p.x - rec.sx, p.y - rec.sy), speed);
      const pass = predictShellPass(p.x, p.y, p.vx, p.vy, rem, local.x, local.y, local.vx, local.vy, this.pass);
      const R = shellDangerRadius(shipR, rec.splash);
      if (!isShellDangerous(pass, R)) continue;
      this.fx[n] = pass.x; this.fy[n] = pass.y;
      this.sx[n] = p.x; this.sy[n] = p.y;
      this.ts[n] = pass.t; this.rs[n] = R;
      n++;
    }
    for (const [id, rec] of this.shells) {
      if (rec.gen === gen) continue;
      this.shells.delete(id);
      this.free.push(rec);
    }
    this.groupCount = this.suppressed || !local || n === 0
      ? 0
      : groupShellPasses(this.fx, this.fy, this.sx, this.sy, this.ts, this.rs, n, 2 * shipR, JOIN_DT_S, this.groups);
    this.draw(nowMs);
  }

  private draw(nowMs: number): void {
    const cam = this.camera;
    const count = cam ? this.groupCount : 0;
    const s = cam && cam.scale.x > 0 ? cam.scale.x : 1;
    // A slow pulse so the marker reads as a warning, not scenery.
    const pulse = 0.7 + 0.3 * Math.sin(nowMs / 160);
    for (let i = 0; i < count; i++) {
      const G = this.groups[i]!;
      const m = this.markers[i] ?? this.makeMarker(i);
      cam!.toScreenInto(G.x, -G.y, this.pt);
      let ringPx = Math.round(G.r * s);
      if (ringPx < RING_MIN_PX) ringPx = RING_MIN_PX;
      if (ringPx > RING_MAX_PX) ringPx = RING_MAX_PX;
      if (ringPx !== m.ringPx) {
        m.ringPx = ringPx;
        paintRing(m.ring, ringPx);
        m.text.y = ringPx + 2;
      }
      const label = countdownLabel(G.t);
      if (label !== m.label) { m.label = label; m.text.text = label; }
      m.root.x = this.pt.x;
      m.root.y = this.pt.y;
      m.root.alpha = pulse;
      m.root.visible = true;
    }
    for (let i = count; i < this.markers.length; i++) this.markers[i]!.root.visible = false;
  }

  private makeMarker(i: number): Marker {
    const root = new Container();
    root.eventMode = 'none';
    const ring = new Graphics();
    const text = new Text({ text: '', style: labelStyle() });
    text.anchor.set(0.5, 0);
    root.addChild(ring, text);
    this.container.addChild(root);
    const m: Marker = { root, ring, text, ringPx: -1, label: '' };
    this.markers[i] = m;
    return m;
  }

  /** Markers drawn this frame (tests / feedback). */
  markerCount(): number {
    let k = 0;
    for (const m of this.markers) if (m.root.visible) k++;
    return k;
  }

  /** Test-only — the drawn markers. */
  getDebugMarkers(): IncomingMarkerDebug[] {
    const out: IncomingMarkerDebug[] = [];
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i]!;
      if (!m.root.visible) continue;
      out.push({ x: m.root.x, y: m.root.y, ringPx: m.ringPx, label: m.label, count: this.groups[i]!.count });
    }
    return out;
  }

  /** Sector handoff: forget every tracked shell. */
  reset(): void {
    for (const rec of this.shells.values()) this.free.push(rec);
    this.shells.clear();
    this.groupCount = 0;
    for (const m of this.markers) m.root.visible = false;
  }

  destroy(): void {
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
    this.markers.length = 0;
    this.camera = null;
  }
}

/** Ring + four inward ticks (a fall-point reticle), radius `r` px. */
function paintRing(g: Graphics, r: number): void {
  g.clear();
  g.circle(0, 0, r);
  g.stroke({ color: INCOMING_COLOR, width: 1.5, alpha: 0.9 });
  const k = Math.min(6, r * 0.4);
  g.moveTo(0, -r).lineTo(0, -r + k);
  g.moveTo(r, 0).lineTo(r - k, 0);
  g.moveTo(0, r).lineTo(0, r - k);
  g.moveTo(-r, 0).lineTo(-r + k, 0);
  g.stroke({ color: INCOMING_COLOR, width: 1.5, alpha: 0.9 });
  g.circle(0, 0, 1.5);
  g.fill({ color: INCOMING_COLOR, alpha: 0.9 });
}
