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
 * reuse it) but stays on screen at its last pose until a wreck piece of the
 * same kind is drawn within its hull, then goes in that same frame. A lost
 * wreck never leaves a ghost: the hold ends after `DYING_HULL_HOLD_MS` of
 * game time. Presentation only; the pieces stay the truth (#16).
 *
 * Every per-frame path is alloc-free (#14): records and the per-frame piece
 * list are pooled and grow once.
 */
import type { Container } from 'pixi.js';
import { getShipKind, isShipKindId } from '@shared-types/shipKinds';
import { isCapitalKindId } from '../art/capitalKind.js';

/** The longest a dying hull waits for its wreck pieces (game ms). */
export const DYING_HULL_HOLD_MS = 1500;

/** A piece counts as this hull's when it is drawn within the hull's radius
 *  times this (pieces start inside the outline and hold together through the
 *  crack delay, so a generous margin never reaches a neighbouring hull). */
const MATCH_RADIUS_MUL = 1.25;

interface DyingMark { id: string; kind: string; atMs: number }
interface Held { sprite: Container | null; kind: string; x: number; y: number; r2: number; untilMs: number }

/** Does a death of a ship of `kind` leave a wreck the client will draw? */
export function deathLeavesWreck(capitalWrecks: boolean | undefined, kind: string | null | undefined): boolean {
  return capitalWrecks === true && typeof kind === 'string' && isCapitalKindId(kind);
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
): void {
  if (exploding === undefined || exploding.size === 0 || capitalWrecks !== true) return;
  for (const id of exploding) {
    const kind = kindOf(id);
    if (deathLeavesWreck(capitalWrecks, kind)) hold.markDying(id, kind!, nowMs);
  }
}

export class DyingHullHold {
  private readonly marks: DyingMark[] = [];
  private markCount = 0;
  private readonly held: Held[] = [];
  private heldCount = 0;
  /** This frame's drawn wreck pieces (pixi space), parallel arrays. */
  private readonly pieceX: number[] = [];
  private readonly pieceY: number[] = [];
  private readonly pieceKind: string[] = [];
  private pieceCount = 0;

  /** A ship died this frame (its id as the sprite maps key it). Only deaths
   *  that leave a wreck are held; see `deathLeavesWreck`. */
  markDying(id: string, kind: string, nowMs: number): void {
    for (let i = 0; i < this.markCount; i++) {
      if (this.marks[i]!.id === id) { this.marks[i]!.kind = kind; this.marks[i]!.atMs = nowMs; return; }
    }
    let m = this.marks[this.markCount];
    if (m === undefined) { m = { id, kind, atMs: nowMs }; this.marks[this.markCount] = m; }
    else { m.id = id; m.kind = kind; m.atMs = nowMs; }
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
    this.dropMark(mark);
    const r = isShipKindId(kind) ? getShipKind(kind).radius * MATCH_RADIUS_MUL : 0;
    let h = this.held[this.heldCount];
    if (h === undefined) { h = { sprite: null, kind: '', x: 0, y: 0, r2: 0, untilMs: 0 }; this.held[this.heldCount] = h; }
    h.sprite = sprite;
    h.kind = kind;
    h.x = sprite.x;
    h.y = sprite.y;
    h.r2 = r * r;
    h.untilMs = nowMs + DYING_HULL_HOLD_MS;
    this.heldCount++;
    return true;
  }

  /** A wreck piece of a `parentKind` capital was drawn this frame at pixi
   *  (x, y). Cheap no-op bookkeeping while nothing is held or dying. */
  notePiece(parentKind: string, x: number, y: number): void {
    if (this.heldCount === 0 && this.markCount === 0) return;
    const i = this.pieceCount++;
    this.pieceX[i] = x;
    this.pieceY[i] = y;
    this.pieceKind[i] = parentKind;
  }

  /**
   * End of the frame, after every sweep: a held hull whose pieces were drawn
   * this frame goes now (the hand-over), as does one past its deadline.
   * Death marks no sweep claimed within the deadline are forgotten.
   */
  settle(nowMs: number): void {
    for (let i = this.heldCount - 1; i >= 0; i--) {
      const h = this.held[i]!;
      if (nowMs >= h.untilMs || this.piecesDrawnFor(h)) this.release(i);
    }
    this.pieceCount = 0;
    for (let i = this.markCount - 1; i >= 0; i--) {
      if (nowMs - this.marks[i]!.atMs >= DYING_HULL_HOLD_MS) this.dropMark(i);
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

  private piecesDrawnFor(h: Held): boolean {
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.pieceKind[i] !== h.kind) continue;
      const dx = this.pieceX[i]! - h.x, dy = this.pieceY[i]! - h.y;
      if (dx * dx + dy * dy <= h.r2) return true;
    }
    return false;
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
