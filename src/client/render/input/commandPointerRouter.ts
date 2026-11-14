/**
 * Command-view pointer router (RTS stream slice 11).
 *
 * Pure, framework-free state machine that decides what a raw pointer
 * gesture means in Command view: camera pan, selection box, tap-select or
 * a right-click order. It emits actions; the caller (PixiRenderer, main
 * thread or worker) performs picking / camera calls / ordering.
 *
 * Rules:
 *  - disabled (Fly mode): every event is passed to the camera unchanged.
 *  - mouse left: never pans. Release under the tap thresholds = tapSelect;
 *    moving >= TAP_THRESHOLD_PX = box (boxStart / boxUpdate / boxEnd).
 *  - mouse right: `order` on release if it never moved >= TAP_THRESHOLD_PX.
 *  - mouse middle / other buttons / hover moves: camera pass-through.
 *  - touch/pen: movement before HOLD_THRESHOLD_MS = camera pan for the rest
 *    of the gesture (the deferred pointerdown is replayed first); stationary
 *    >= HOLD_THRESHOLD_MS then move = box; quick tap = tapSelect. A second
 *    simultaneous pointer (pinch) cancels any box and routes everything to
 *    the camera until all pointers lift.
 */
import { classifyTap } from '../worker/camera/tapVsDrag.js';

/** Same values as Camera's default classifyTap thresholds. */
export const TAP_THRESHOLD_PX = 6;
export const TAP_THRESHOLD_MS = 250;
/** Touch press-and-hold before a drag becomes a selection box. */
export const HOLD_THRESHOLD_MS = 500;

export interface RouterPointerEvent {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  pointerId: number;
  /** 0 left, 1 middle, 2 right (DOM PointerEvent.button). */
  button: number;
  buttons: number;
  /** Screen px (canvas-relative). */
  x: number;
  y: number;
  shiftKey: boolean;
  /** 'mouse' | 'touch' | 'pen' */
  pointerType: string;
  timeMs: number;
}

/** See {@link CommandPointerRouter.holdArmedAt}. */
export interface HoldArmed {
  /** Screen px of the held pointer's down point. */
  x: number;
  y: number;
  /** Ms since the hold armed (0 at the threshold). */
  armedMs: number;
}

export interface BoxRect { x0: number; y0: number; x1: number; y1: number }

export type RouterAction =
  | { kind: 'camera'; ev: RouterPointerEvent }
  | ({ kind: 'boxStart' } & BoxRect)
  | ({ kind: 'boxUpdate' } & BoxRect)
  | ({ kind: 'boxEnd'; additive: boolean } & BoxRect)
  | { kind: 'boxCancel' }
  | { kind: 'tapSelect'; x: number; y: number; additive: boolean; pointerType: string }
  | { kind: 'order'; x: number; y: number };

type Mode =
  | 'idle'
  | 'pending' // primary down, intent not decided yet
  | 'box'
  | 'right' // mouse right held
  | 'camera'; // everything to camera until all pointers up

interface Gesture {
  pointerId: number;
  isMouse: boolean;
  downEv: RouterPointerEvent;
  movedPastTap: boolean;
}

export class CommandPointerRouter {
  private _enabled: boolean;
  private mode: Mode = 'idle';
  private g: Gesture | null = null;
  private readonly active = new Set<number>();
  /** Pointers whose down was delivered to the camera (so move/up follow). */
  private readonly cameraOwned = new Set<number>();

  constructor(enabled = true) {
    this._enabled = enabled;
  }

  get enabled(): boolean { return this._enabled; }

  /** Toggle Command (true) vs Fly (false). Resets any in-flight gesture. */
  setEnabled(enabled: boolean): RouterAction[] {
    if (enabled === this._enabled) return [];
    const out: RouterAction[] = [];
    if (this.mode === 'box') out.push({ kind: 'boxCancel' });
    this._enabled = enabled;
    this.reset();
    return out;
  }

  /**
   * Hold-to-box cue: while a touch/pen pointer has been held still for at
   * least HOLD_THRESHOLD_MS (so its next move draws a box), returns its down
   * point (screen px) and how long it has been armed; null otherwise. Polled
   * once per renderer frame; writes into `out` (no allocation).
   */
  holdArmedAt(nowMs: number, out: HoldArmed): HoldArmed | null {
    if (!this._enabled || this.mode !== 'pending') return null;
    const g = this.g;
    if (g === null || g.isMouse || g.movedPastTap) return null;
    const held = nowMs - g.downEv.timeMs;
    if (held < HOLD_THRESHOLD_MS) return null;
    out.x = g.downEv.x;
    out.y = g.downEv.y;
    out.armedMs = held - HOLD_THRESHOLD_MS;
    return out;
  }

  reset(): void {
    this.mode = 'idle';
    this.g = null;
    this.active.clear();
    this.cameraOwned.clear();
  }

  handle(ev: RouterPointerEvent): RouterAction[] {
    if (!this._enabled) return [{ kind: 'camera', ev }];
    switch (ev.type) {
      case 'pointerdown': return this.down(ev);
      case 'pointermove': return this.move(ev);
      case 'pointerup': return this.up(ev, false);
      case 'pointercancel': return this.up(ev, true);
    }
    return [];
  }

  private down(ev: RouterPointerEvent): RouterAction[] {
    this.active.add(ev.pointerId);
    const isMouse = ev.pointerType === 'mouse';

    if (this.mode === 'camera') return this.toCamera(ev);

    if (this.mode !== 'idle') {
      if (!isMouse && this.g !== null && !this.g.isMouse) {
        // Pinch: cancel box / replay deferred down, then camera owns all.
        const out: RouterAction[] = [];
        if (this.mode === 'box') out.push({ kind: 'boxCancel' });
        else if (this.mode === 'pending') out.push(...this.toCamera(this.g.downEv));
        this.mode = 'camera';
        out.push(...this.toCamera(ev));
        return out;
      }
      // Extra mouse button / mixed input mid-gesture: ignore.
      this.active.delete(ev.pointerId);
      return [];
    }

    if (isMouse) {
      if (ev.button === 0) { this.begin(ev, true); this.mode = 'pending'; return []; }
      if (ev.button === 2) { this.begin(ev, true); this.mode = 'right'; return []; }
      this.mode = 'camera';
      return this.toCamera(ev);
    }
    // touch / pen: defer until intent is known.
    this.begin(ev, false);
    this.mode = 'pending';
    return [];
  }

  private move(ev: RouterPointerEvent): RouterAction[] {
    if (this.cameraOwned.has(ev.pointerId)) return [{ kind: 'camera', ev }];
    if (this.mode === 'idle') return [{ kind: 'camera', ev }]; // hover
    const g = this.g;
    if (g === null || ev.pointerId !== g.pointerId) return [];
    const d = g.downEv;
    if (!g.movedPastTap && Math.hypot(ev.x - d.x, ev.y - d.y) >= TAP_THRESHOLD_PX) g.movedPastTap = true;

    switch (this.mode) {
      case 'box':
        return [{ kind: 'boxUpdate', x0: d.x, y0: d.y, x1: ev.x, y1: ev.y }];
      case 'pending': {
        if (!g.movedPastTap) return [];
        if (g.isMouse || ev.timeMs - d.timeMs >= HOLD_THRESHOLD_MS) {
          this.mode = 'box';
          return [{ kind: 'boxStart', x0: d.x, y0: d.y, x1: ev.x, y1: ev.y }];
        }
        // Touch moved before the hold threshold → pan for the rest of the gesture.
        this.mode = 'camera';
        return [...this.toCamera(d), { kind: 'camera', ev }];
      }
      default:
        return [];
    }
  }

  private up(ev: RouterPointerEvent, cancelled: boolean): RouterAction[] {
    const out: RouterAction[] = [];
    if (this.cameraOwned.has(ev.pointerId)) {
      this.cameraOwned.delete(ev.pointerId);
      this.active.delete(ev.pointerId);
      out.push({ kind: 'camera', ev });
    } else if (!this.active.has(ev.pointerId)) {
      return this.mode === 'idle' ? [{ kind: 'camera', ev }] : [];
    } else {
      this.active.delete(ev.pointerId);
      const g = this.g;
      if (g !== null && ev.pointerId === g.pointerId) {
        const d = g.downEv;
        const additive = d.shiftKey || ev.shiftKey;
        if (this.mode === 'box') {
          out.push(cancelled
            ? { kind: 'boxCancel' }
            : { kind: 'boxEnd', x0: d.x, y0: d.y, x1: ev.x, y1: ev.y, additive });
        } else if (!cancelled && this.mode === 'right') {
          if (!g.movedPastTap && Math.hypot(ev.x - d.x, ev.y - d.y) < TAP_THRESHOLD_PX) {
            out.push({ kind: 'order', x: ev.x, y: ev.y });
          }
        } else if (!cancelled && this.mode === 'pending' && !g.movedPastTap) {
          const cls = classifyTap(d.x, d.y, ev.x, ev.y, d.timeMs, ev.timeMs, {
            tapThresholdPx: TAP_THRESHOLD_PX, tapThresholdMs: TAP_THRESHOLD_MS,
          });
          if (cls.isTap) out.push({ kind: 'tapSelect', x: ev.x, y: ev.y, additive, pointerType: d.pointerType });
        }
      }
    }
    if (this.active.size === 0 && this.cameraOwned.size === 0) {
      this.mode = 'idle';
      this.g = null;
    }
    return out;
  }

  private begin(ev: RouterPointerEvent, isMouse: boolean): void {
    this.g = { pointerId: ev.pointerId, isMouse, downEv: ev, movedPastTap: false };
  }

  private toCamera(ev: RouterPointerEvent): RouterAction[] {
    if (ev.type === 'pointerdown') this.cameraOwned.add(ev.pointerId);
    return [{ kind: 'camera', ev }];
  }
}
