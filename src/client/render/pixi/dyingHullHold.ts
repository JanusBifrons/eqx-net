/**
 * Capital destruction: the dying hull stays drawn until its wreck pieces are.
 *
 * Filmed bug (capital-breakup take B, 2026-11-13): the cruiser vanished for
 * ~0.5 s before its wreck pieces appeared, and the kill blast and damage
 * number floated over empty space. The hull's sprite was swept the frame its
 * entity left the mirror (a `destroy` event, or the first snapshot without
 * the parked hull), but a wreck piece is drawn only once BOTH its binary pose
 * and its `wrecks[]` descriptor (slim JSON snapshot) have arrived. Pieces of a
 * wreck the viewer has no interest in ride the binary wire only every
 * `DECIMATION_TICKS` (a spectator has no slot, so every piece is out of
 * interest), and the descriptor rides a different channel, so for a window
 * nothing was drawn.
 *
 * Now a capital that dies in a room that breaks capitals (`capitalWrecks`) is
 * HELD: its sprite leaves the renderer's id-keyed maps (so a recycled id can't
 * reuse it) but stays on screen at its last pose until EVERY piece of its
 * wreck is drawable, then goes in that same frame. The wreck is identified by
 * the first drawn piece of the same kind inside the hull; its piece count
 * comes from the rebuilt geometry. While the hold waits, the pieces that have
 * already arrived are hidden (filmed after #540: pieces reach the binary wire
 * at different ticks, so ending the hold on the first one showed the middle
 * chunk alone, then the stern, then the bow). Every frame shows the whole hull
 * or the whole wreck. A lost wreck never leaves a ghost: the hold ends after
 * `DYING_HULL_HOLD_MS` of game time and whatever pieces arrived show.
 * Presentation only; the pieces stay the truth (#16).
 *
 * Every per-frame path is alloc-free (#14): records and the per-frame piece
 * list are pooled and grow once.
 *
 * Sub-capitals (sub-capital break-up, slice 4): in a room that breaks them
 * (`subcapWrecks`) a dying sub-cap is held the same way, with the profile's
 * brief deadline (`fx.dyingHoldMs`, 600 ms: no crack hold, so its pieces
 * are drawable at once).
 */
import type { Container } from 'pixi.js';
import { getShipKind, isShipKindId } from '@shared-types/shipKinds';
import { destructionProfileOf } from '@shared-types/shipScale/destructionProfile';

/** The longest a dying capital waits for its wreck pieces (game ms). */
export const DYING_HULL_HOLD_MS = 1500;

/** A piece counts as this hull's when it is drawn within the hull's radius
 *  times this (pieces start inside the outline and hold together through the
 *  crack delay, so a generous margin never reaches a neighbouring hull). */
const MATCH_RADIUS_MUL = 1.25;

interface DyingMark { id: string; kind: string; atMs: number; holdMs: number }
interface Held {
  sprite: Container | null; kind: string; x: number; y: number; r2: number; untilMs: number;
  /** The wreck this hull became (-1 until a piece of it is drawn) and its piece count. */
  wreckId: number; total: number;
}

/** How long a death of a ship of `kind` holds its hull for its wreck (game
 *  ms; 0: it leaves no wreck the client will draw). Capitals in a
 *  `capitalWrecks` room, sub-capitals in a `subcapWrecks` room; each its
 *  profile's `fx.dyingHoldMs`. */
export function dyingHoldMsFor(capitalWrecks: boolean | undefined, kind: string | null | undefined, subcapWrecks?: boolean): number {
  if (typeof kind !== 'string' || !isShipKindId(kind)) return 0;
  const p = destructionProfileOf({ type: 'ship', kindId: kind });
  const on = p.id === 'capital' ? capitalWrecks === true : p.id === 'subcap' ? subcapWrecks === true : false;
  return on ? p.fx.dyingHoldMs : 0;
}

/** Does a death of a ship of `kind` leave a wreck the client will draw? */
export function deathLeavesWreck(capitalWrecks: boolean | undefined, kind: string | null | undefined, subcapWrecks?: boolean): boolean {
  return dyingHoldMsFor(capitalWrecks, kind, subcapWrecks) > 0;
}

/**
 * This frame's deaths (`mirror.explodingShips`, keyed as the sprite maps key
 * them): mark each one that leaves a wreck. `kindOf` resolves a sprite key to
 * the ship kind it was built for. Alloc-free.
 */
export function noteDyingHulls(
  exploding: ReadonlySet<string> | undefined,
  capitalWrecks: boolean | undefined,
  kindOf: (id: string) => string | null | undefined,
  hold: DyingHullHold,
  nowMs: number,
  subcapWrecks?: boolean,
): void {
  if (exploding === undefined || exploding.size === 0 || (capitalWrecks !== true && subcapWrecks !== true)) return;
  for (const id of exploding) {
    const kind = kindOf(id);
    const holdMs = dyingHoldMsFor(capitalWrecks, kind, subcapWrecks);
    if (holdMs > 0) hold.markDying(id, kind!, nowMs, holdMs);
  }
}

export class DyingHullHold {
  private readonly marks: DyingMark[] = [];
  private markCount = 0;
  private readonly held: Held[] = [];
  private heldCount = 0;
  /** This frame's drawn wreck pieces, parallel arrays (sprites give the pixi pose). */
  private readonly pieceSprite: (Container | null)[] = [];
  private readonly pieceKind: string[] = [];
  private readonly pieceWreck: number[] = [];
  private readonly pieceTotal: number[] = [];
  private pieceCount = 0;

  /** A ship died this frame (its id as the sprite maps key it). Only deaths
   *  that leave a wreck are held; see `deathLeavesWreck`. */
  markDying(id: string, kind: string, nowMs: number, holdMs = DYING_HULL_HOLD_MS): void {
    for (let i = 0; i < this.markCount; i++) {
      const m = this.marks[i]!;
      if (m.id === id) { m.kind = kind; m.atMs = nowMs; m.holdMs = holdMs; return; }
    }
    let m = this.marks[this.markCount];
    if (m === undefined) { m = { id, kind, atMs: nowMs, holdMs }; this.marks[this.markCount] = m; }
    else { m.id = id; m.kind = kind; m.atMs = nowMs; m.holdMs = holdMs; }
    this.markCount++;
  }

  /**
   * A sweep is about to destroy `sprite` (key `id`). Returns true when the
   * hold takes it instead: the caller drops its map entries but must NOT
   * destroy the sprite (the hold destroys it on release).
   */
  tryHold(id: string, sprite: Container, nowMs: number): boolean {
    let mark = -1;
    for (let i = 0; i < this.markCount; i++) if (this.marks[i]!.id === id) { mark = i; break; }
    if (mark < 0) return false;
    const kind = this.marks[mark]!.kind;
    const holdMs = this.marks[mark]!.holdMs;
    this.dropMark(mark);
    const r = isShipKindId(kind) ? getShipKind(kind).radius * MATCH_RADIUS_MUL : 0;
    let h = this.held[this.heldCount];
    if (h === undefined) {
      h = { sprite: null, kind: '', x: 0, y: 0, r2: 0, untilMs: 0, wreckId: -1, total: 0 };
      this.held[this.heldCount] = h;
    }
    h.sprite = sprite;
    h.kind = kind;
    h.x = sprite.x;
    h.y = sprite.y;
    h.r2 = r * r;
    h.untilMs = nowMs + holdMs;
    h.wreckId = -1;
    h.total = 0;
    this.heldCount++;
    return true;
  }

  /** A piece of wreck `wreckId` (a `parentKind` capital, `total` pieces in
   *  all) was drawn this frame as `sprite` (visible; the caller sets that each
   *  frame). Cheap no-op bookkeeping while nothing is held or dying. */
  notePiece(parentKind: string, wreckId: number, total: number, sprite: Container): void {
    if (this.heldCount === 0 && this.markCount === 0) return;
    const i = this.pieceCount++;
    this.pieceSprite[i] = sprite;
    this.pieceKind[i] = parentKind;
    this.pieceWreck[i] = wreckId;
    this.pieceTotal[i] = total;
  }

  /**
   * End of the frame, after every sweep: a held hull goes now when every
   * piece of its wreck was drawn this frame (the hand-over), or at its
   * deadline. Until then its pieces drawn so far are hidden, so no frame
   * shows part of the wreck. Death marks no sweep claimed within the deadline
   * are forgotten.
   */
  settle(nowMs: number): void {
    for (let i = this.heldCount - 1; i >= 0; i--) {
      const h = this.held[i]!;
      if (h.wreckId < 0) this.findWreckFor(h);
      if (nowMs >= h.untilMs) { this.release(i); continue; }
      if (h.wreckId < 0) continue;
      if (this.countPieces(h.wreckId) >= h.total) { this.release(i); continue; }
      this.hidePieces(h.wreckId);
    }
    for (let i = 0; i < this.pieceCount; i++) this.pieceSprite[i] = null; // no stale sprite refs
    this.pieceCount = 0;
    for (let i = this.markCount - 1; i >= 0; i--) {
      if (nowMs - this.marks[i]!.atMs >= this.marks[i]!.holdMs) this.dropMark(i);
    }
  }

  /** Held hulls (each drawn at its last pose). */
  heldCountNow(): number {
    return this.heldCount;
  }

  /** The held sprites, for the renderer's per-frame light refresh. */
  heldSprite(i: number): Container {
    return this.held[i]!.sprite!;
  }

  /** Bind a held hull to the wreck of the first piece of its kind drawn
   *  inside it. */
  private findWreckFor(h: Held): void {
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.pieceKind[i] !== h.kind) continue;
      const s = this.pieceSprite[i]!;
      const dx = s.x - h.x, dy = s.y - h.y;
      if (dx * dx + dy * dy <= h.r2) { h.wreckId = this.pieceWreck[i]!; h.total = this.pieceTotal[i]!; return; }
    }
  }

  private countPieces(wreckId: number): number {
    let n = 0;
    for (let i = 0; i < this.pieceCount; i++) if (this.pieceWreck[i] === wreckId) n++;
    return n;
  }

  private hidePieces(wreckId: number): void {
    for (let i = 0; i < this.pieceCount; i++) if (this.pieceWreck[i] === wreckId) this.pieceSprite[i]!.visible = false;
  }

  private release(i: number): void {
    const h = this.held[i]!;
    const sprite = h.sprite;
    // Swap-remove, keeping the record object pooled.
    const last = this.heldCount - 1;
    if (i !== last) { this.held[i] = this.held[last]!; this.held[last] = h; }
    this.heldCount = last;
    h.sprite = null;
    if (sprite !== null) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy({ children: true });
    }
  }

  private dropMark(i: number): void {
    const last = this.markCount - 1;
    if (i !== last) {
      const m = this.marks[i]!;
      this.marks[i] = this.marks[last]!;
      this.marks[last] = m;
    }
    this.markCount = last;
  }
}
