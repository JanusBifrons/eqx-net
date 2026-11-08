/**
 * Scripted multi-touch and mouse input for shots.
 *
 * Touch goes through CDP `Input.dispatchTouchEvent`, so the page sees real
 * touch events AND the pointer events Chrome derives from them (pointerType
 * 'touch'), exactly like a phone. Each finger has a stable id; several can be
 * down at once (left thumb steering while the right thumb aims), and moves
 * are sampled against wall-clock time so gestures keep their timing even when
 * a CDP round-trip is slow.
 *
 *   const t = await touch(ctx.page);
 *   const left = t.finger();
 *   await left.down(110, 280);
 *   await left.dragTo(110, 225, { ms: 400 });
 *   await left.circle({ center: { x: 110, y: 280 }, r: 55, from: -Math.PI / 2, to: 0, ms: 3000 });
 *   await left.up();
 *   await t.dispose();
 *
 * CDP semantics: every event carries the FULL set of fingers still down —
 * Chrome diffs it against the previous set (new id = press, moved = move,
 * missing = release). So `touchEnd` lists the fingers that REMAIN down.
 * Context must be created with `hasTouch: true` (all phone viewports are).
 *
 * The mouse side (`mouse(page)`) does the same for desktop takes with
 * Playwright's `page.mouse`: smooth glides and sweeps with a button held.
 */
import type { CDPSession, Page } from '@playwright/test';
import { arc, easeInOut, line, sample, still, wiggle, type Curve, type Ease, type Pt } from './touchPath.js';

const FRAME_MS = 16;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface GlideOpts {
  /** Duration (default 400 ms). */
  ms?: number;
  /** Easing (default sine in-out). */
  ease?: Ease;
}

type TouchType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';

/** Run `curve` over `ms`, calling `apply` each ~frame with the eased point; ends exactly on curve(1). */
async function animate(curve: Curve, o: GlideOpts, apply: (p: Pt) => Promise<void>): Promise<void> {
  const ms = Math.max(0, o.ms ?? 400);
  const ease = o.ease ?? easeInOut;
  const t0 = Date.now();
  for (;;) {
    const u = ms === 0 ? 1 : (Date.now() - t0) / ms;
    if (u >= 1) break;
    const frameStart = Date.now();
    await apply(sample(curve, ease, u));
    await sleep(FRAME_MS - (Date.now() - frameStart));
  }
  await apply(sample(curve, ease, 1));
}

export class TouchPad {
  private nextId = 1;
  private readonly active = new Map<number, Pt>();
  private chain: Promise<void> = Promise.resolve();
  private moveQueued = false;
  private warned = false;

  constructor(
    private readonly cdp: CDPSession,
    private readonly log: (m: string) => void,
  ) {}

  /** A new finger (not yet touching). */
  finger(): Finger {
    return new Finger(this, this.nextId++);
  }

  /** Lift every finger still down. */
  async releaseAll(): Promise<void> {
    if (this.active.size === 0) return;
    const lifted = [...this.active];
    this.active.clear();
    await this.emit('touchEnd', lifted);
  }

  /** Release fingers and detach the CDP session. */
  async dispose(): Promise<void> {
    await this.releaseAll().catch(() => {});
    await this.chain.catch(() => {});
    await this.cdp.detach().catch(() => {});
  }

  /** @internal */ press(id: number, p: Pt): Promise<void> {
    this.active.set(id, { x: p.x, y: p.y });
    return this.emit('touchStart');
  }

  /** @internal */ move(id: number, p: Pt): Promise<void> {
    const cur = this.active.get(id);
    if (!cur) return Promise.resolve();
    cur.x = p.x;
    cur.y = p.y;
    return this.emit('touchMove');
  }

  /** @internal */ release(id: number): Promise<void> {
    const p = this.active.get(id);
    if (!p || !this.active.delete(id)) return Promise.resolve();
    // CDP ends exactly the points LISTED in a touchEnd. Listing the fingers
    // still down (the old behaviour) lifted the OTHER thumb and left this one
    // stuck down, so every later press of this finger was ignored (a held
    // BOOST, a dead twin-stick aim in the landscape take).
    return this.emit('touchEnd', [[id, p]]);
  }

  /**
   * Serialise events in order. Moves coalesce: if a move is already queued,
   * this one is dropped — the queued one reads the fingers' positions when it
   * is SENT, so it carries the latest state anyway. Start/end never coalesce.
   */
  private emit(type: TouchType, endPoints?: [number, Pt][]): Promise<void> {
    if (type === 'touchMove') {
      if (this.moveQueued) return this.chain;
      this.moveQueued = true;
    }
    this.chain = this.chain
      .then(async () => {
        if (type === 'touchMove') this.moveQueued = false;
        const touchPoints = (endPoints ?? [...this.active]).map(([id, p]) => ({
          x: p.x,
          y: p.y,
          id,
          radiusX: 11,
          radiusY: 11,
          force: 1,
        }));
        if (type === 'touchMove' && touchPoints.length === 0) return;
        await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      })
      .catch((e: Error) => {
        if (!this.warned) {
          this.warned = true;
          this.log(`  [touch] dispatch failed: ${e.message.split('\n')[0]}`);
        }
      });
    return this.chain;
  }
}

export class Finger {
  private p: Pt | null = null;

  constructor(
    private readonly pad: TouchPad,
    readonly id: number,
  ) {}

  /** Where the finger is (null when lifted). */
  get pos(): Pt | null {
    return this.p ? { x: this.p.x, y: this.p.y } : null;
  }

  get isDown(): boolean {
    return this.p !== null;
  }

  async down(x: number, y: number): Promise<void> {
    if (this.p) await this.up();
    this.p = { x, y };
    await this.pad.press(this.id, this.p);
  }

  /** Jump (one move event). */
  async moveTo(x: number, y: number): Promise<void> {
    if (!this.p) throw new Error(`finger ${this.id} is not down`);
    this.p = { x, y };
    await this.pad.move(this.id, this.p);
  }

  /** Smooth drag to (x, y). */
  async dragTo(x: number, y: number, o: GlideOpts = {}): Promise<void> {
    const from = this.requirePos();
    await this.follow(line(from, { x, y }), o);
  }

  /** Drag along any curve (it should start near the finger: no jump is smoothed). */
  async follow(curve: Curve, o: GlideOpts = {}): Promise<void> {
    this.requirePos();
    await animate(curve, o, async (p) => {
      if (!this.p) return; // lifted mid-gesture by another task
      this.p = p;
      await this.pad.move(this.id, p);
    });
  }

  /**
   * Roll around `center` at radius r from angle `from` to `to` (screen
   * radians: 0 = right, −π/2 = up). Glides onto the arc's start first if the
   * finger isn't already there. Natural for steering an analog stick in arcs.
   */
  async circle(o: { center: Pt; r: number; from: number; to: number; ms: number; ease?: Ease }): Promise<void> {
    const c = arc(o.center.x, o.center.y, o.r, o.from, o.to);
    const start = c(0);
    const cur = this.requirePos();
    if (Math.hypot(start.x - cur.x, start.y - cur.y) > 2) await this.dragTo(start.x, start.y, { ms: 150 });
    await this.follow(c, { ms: o.ms, ease: o.ease ?? ((u) => u) });
  }

  /**
   * Sway sideways around the current position (or along the way to `to`):
   * small corrections a thumb makes while holding a direction.
   */
  async wiggle(o: { amp: number; cycles: number; ms: number; to?: Pt }): Promise<void> {
    const cur = this.requirePos();
    const base = o.to ? line(cur, o.to) : still(cur);
    await this.follow(wiggle(base, o.amp, o.cycles), { ms: o.ms, ease: (u) => u });
  }

  /** Keep the finger where it is for `ms`, re-sending its position so the page sees it is still held. */
  async hold(ms: number): Promise<void> {
    const cur = this.requirePos();
    await this.follow(still(cur), { ms, ease: (u) => u });
  }

  async up(): Promise<void> {
    if (!this.p) return;
    this.p = null;
    await this.pad.release(this.id);
  }

  /** Quick tap (down, hold `ms`, up). */
  async tap(x: number, y: number, ms = 90): Promise<void> {
    await this.down(x, y);
    await sleep(ms);
    await this.up();
  }

  private requirePos(): Pt {
    if (!this.p) throw new Error(`finger ${this.id} is not down`);
    return this.p;
  }
}

/** Multi-touch driver for a page (its context needs `hasTouch: true`). */
export async function touch(page: Page, log: (m: string) => void = console.log): Promise<TouchPad> {
  const cdp = await page.context().newCDPSession(page);
  return new TouchPad(cdp, log);
}

// ---------------------------------------------------------------------------
// Desktop mouse

export class Mouse {
  private p: Pt;
  private readonly held = new Set<'left' | 'right' | 'middle'>();

  constructor(
    private readonly page: Page,
    start: Pt,
  ) {
    this.p = { ...start };
  }

  get pos(): Pt {
    return { ...this.p };
  }

  /** Place the cursor (no animation). */
  async jump(x: number, y: number): Promise<void> {
    this.p = { x, y };
    await this.page.mouse.move(x, y);
  }

  /** Smooth move to (x, y), keeping whatever buttons are held. */
  async glideTo(x: number, y: number, o: GlideOpts = {}): Promise<void> {
    await this.follow(line(this.p, { x, y }), o);
  }

  /** Move along a curve (e.g. an `arc` sweep across targets). */
  async follow(curve: Curve, o: GlideOpts = {}): Promise<void> {
    await animate(curve, o, async (p) => {
      this.p = p;
      await this.page.mouse.move(p.x, p.y);
    });
  }

  async down(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (this.held.has(button)) return;
    this.held.add(button);
    await this.page.mouse.down({ button });
  }

  async up(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (!this.held.delete(button)) return;
    await this.page.mouse.up({ button });
  }

  /** Release every held button. */
  async releaseAll(): Promise<void> {
    for (const b of [...this.held]) await this.up(b);
  }
}

/** Desktop mouse driver; the cursor starts at `start` (default: viewport centre). */
export async function mouse(page: Page, start?: Pt): Promise<Mouse> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const s = start ?? { x: vp.width / 2, y: vp.height / 2 };
  const m = new Mouse(page, s);
  await m.jump(s.x, s.y);
  return m;
}
