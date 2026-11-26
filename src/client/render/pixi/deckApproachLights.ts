/**
 * Base platforms — runway approach lights outside every deck fence gate
 * (owner: "just off the end of a runway where there's blinking lights that
 * sort of guide you in"). Part of the deck floor layer: {@link StructureDeckPlates}
 * owns one of these (like the zone paint, `structureDeckZones.ts`); not a
 * layer of its own. `?approach=on` turns it on; default OFF until the owner
 * signs off the look.
 *
 * A gate (`shield_gate`) stands on a hex seam's midpoint, turned along the
 * seam (`deckGateRoad.ts`): the road through it runs along the gate's local
 * ±y. The lamps run in a straight line down that road on the OUTSIDE of the
 * fence (the seam side whose hex is on no deck plate), {@link APPROACH_LAMP_COUNT}
 * lamps {@link APPROACH_LAMP_SPACING} apart from {@link APPROACH_LAMP_START}
 * off the seam. A white "rabbit" strobe walks lamp by lamp TOWARD the gate
 * every {@link APPROACH_PERIOD_MS} of effect time (`fxNow`, invariant 20);
 * between pulses each lamp is a steady dim amber base. A gate with plates on
 * both sides of its seam (or neither) has no outside and gets no lamps.
 *
 * Static geometry (a Container per gate, a base + a flash Graphics per lamp on
 * two shared `GraphicsContext`s) is built when a gate appears and re-placed
 * only when its pose or the plate set changes; a frame writes only the flash
 * alphas of on-screen gates (invariant #14).
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { DECK_FENCE_GATE_KIND } from '../../../core/structures/deckLinks.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';

/** `?approach=on|off` — default off (taste change pending the owner's OK). */
export function readApproachFlag(search: string): boolean {
  return /[?&]approach=on\b/.test(search);
}

export const APPROACH_LAMP_COUNT = 6;
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

/** Lamp look (world units). */
export const LAMP_HOUSING = 0x1a1d22;
export const LAMP_AMBER = 0xffc060;
export const LAMP_BASE_ALPHA = 0.6;
export const LAMP_FLASH = 0xffffff;

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

let baseCtx: GraphicsContext | undefined;
let flashCtx: GraphicsContext | undefined;

/** The shared steady lamp: a dark housing with a dim amber lens (built once). */
export function approachBaseContext(): GraphicsContext {
  if (baseCtx === undefined) {
    baseCtx = new GraphicsContext()
      .circle(0, 0, 20).fill({ color: LAMP_HOUSING })
      .circle(0, 0, 12).fill({ color: LAMP_AMBER, alpha: LAMP_BASE_ALPHA });
  }
  return baseCtx;
}

/** The shared strobe: a white core in a soft halo (its alpha is the flash). */
export function approachFlashContext(): GraphicsContext {
  if (flashCtx === undefined) {
    flashCtx = new GraphicsContext()
      .circle(0, 0, 75).fill({ color: LAMP_FLASH, alpha: 0.1 })
      .circle(0, 0, 40).fill({ color: LAMP_FLASH, alpha: 0.25 })
      .circle(0, 0, 16).fill({ color: LAMP_FLASH, alpha: 1 });
  }
  return flashCtx;
}

/** Half the lamp line's length plus the halo: the cull radius round its middle. */
const CULL_R = ((APPROACH_LAMP_COUNT - 1) * APPROACH_LAMP_SPACING) / 2 + 80;
const MID_D = APPROACH_LAMP_START + ((APPROACH_LAMP_COUNT - 1) * APPROACH_LAMP_SPACING) / 2;

interface GateEntry {
  c: Container;
  flashes: Graphics[];
  stamp: number;
  x: number; y: number; a: number;
  /** Plate version the side was worked out against. */
  plates: number;
  sign: number;
  /** Pixi centre of the lamp line (cull). */
  mx: number; my: number;
}

/**
 * The approach lights of every deck fence gate. The swarm updater notes each
 * structure ({@link note}); {@link frame} runs at the start of the next frame
 * (sweep gone gates, then strobe the live, on-screen ones).
 */
export class DeckApproachLights {
  private readonly entries = new Map<number, GateEntry>();
  private stamp = 0;
  private deck = false;
  private plateVersion = 0;
  private readonly pt = new Float64Array(2);
  private nowMs = 0;
  private bounds: Float64Array | undefined;
  private readonly sweepFn = (e: GateEntry, id: number): void => {
    if (e.stamp !== this.stamp) this.drop(id, e);
  };
  private readonly strobeFn = (e: GateEntry): void => {
    e.c.visible = e.sign !== 0 && isSpriteInView(e.mx, e.my, CULL_R, this.bounds);
    if (!e.c.visible) return;
    for (let k = 0; k < e.flashes.length; k++) {
      const g = e.flashes[k]!;
      const f = approachFlash(k, APPROACH_LAMP_COUNT, this.nowMs);
      g.visible = f > 0;
      g.alpha = f;
    }
  };

  /** `onPlate(x, y)`: is the deck hex at game (x, y) plated (the floor's set). */
  constructor(private readonly shipContainer: Container, private readonly onPlate: (x: number, y: number) => boolean) {}

  /** Live gates (tests, stats). */
  get size(): number { return this.entries.size; }

  /** The lamp Container of gate `id` (tests). */
  containerOf(id: number): Container | undefined { return this.entries.get(id)?.c; }

  /** Free gates not noted since the last call, strobe the rest at effect time
   *  `nowMs` (on-screen only: `bounds`, pixi space), then start a frame. */
  frame(deck: boolean, plateVersion: number, nowMs: number, bounds: Float64Array | undefined): void {
    this.deck = deck;
    this.plateVersion = plateVersion;
    if (!deck) this.stamp++; // off the deck: everything goes now
    this.entries.forEach(this.sweepFn);
    this.nowMs = nowMs;
    this.bounds = bounds;
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
    e.c.position.set(x, -y); // Y-flip
    const lamps = e.c.children;
    for (let k = 0; k < APPROACH_LAMP_COUNT; k++) {
      approachLampInto(0, 0, angle, e.sign, k, this.pt);
      lamps[2 * k]!.position.set(this.pt[0]!, -this.pt[1]!);
      lamps[2 * k + 1]!.position.set(this.pt[0]!, -this.pt[1]!);
    }
    e.mx = x - Math.sin(angle) * e.sign * MID_D;
    e.my = -(y + Math.cos(angle) * e.sign * MID_D);
  }

  destroy(): void {
    this.stamp++;
    this.entries.forEach(this.sweepFn);
  }

  /** Build time: a gate's Container with a base + a flash per lamp. */
  private build(id: number): GateEntry {
    const c = new Container();
    c.label = 'deckApproach';
    c.zIndex = APPROACH_LAMP_Z;
    const flashes: Graphics[] = [];
    for (let k = 0; k < APPROACH_LAMP_COUNT; k++) {
      c.addChild(new Graphics(approachBaseContext()));
      const f = new Graphics(approachFlashContext());
      f.visible = false;
      c.addChild(f);
      flashes.push(f);
    }
    this.shipContainer.sortableChildren = true;
    this.shipContainer.addChild(c);
    const e: GateEntry = { c, flashes, stamp: 0, x: Number.NaN, y: Number.NaN, a: Number.NaN, plates: -1, sign: 0, mx: 0, my: 0 };
    this.entries.set(id, e);
    return e;
  }

  private drop(id: number, e: GateEntry): void {
    e.c.parent?.removeChild(e.c);
    e.c.destroy({ children: true }); // the shared contexts survive
    this.entries.delete(id);
  }
}
