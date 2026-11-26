/**
 * Base platforms slice 30 — the deck fence beam look (`?fenceLook=old|new`).
 *
 * On a deck room the fence ring is shield pylons on the outer hex corners,
 * linked post to post along the seams (`DECK_LINK_SEAM_FENCE`), with gates in
 * the ring (`DECK_LINK_SEAM_GATE`). `old` (today): those links draw as the
 * same power cable as every plate seam link, so only the pylons show where
 * the ring is. `new`: a fence link draws as a shield-fence beam instead (the
 * shield wall's colours and band, R2.19 `shieldWallVisualParams`: cyan glow
 * + two rails, dim red when the wall is down), at the cable's on-screen
 * width floor so it reads as far out as the cables do. The wall's animated
 * part (glow breathing + shimmer, or the `?fx=new` fence sprites) still
 * comes from the derived walls on top; this only replaces the cable body
 * and its flow on those links. Which links are fence links is core
 * `deckLinkKind` (the rule the server links them by), never a new classifier.
 *
 * Static layer only (the chunked, zoom-keyed contexts): no per-frame work.
 * Allocation-free (module scratch, invariant 14).
 */
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import {
  DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND, DECK_LINK_SEAM_FENCE, DECK_LINK_SEAM_GATE, deckLinkKind,
} from '../../../core/structures/deckLinks.js';
import { cableLookWidth, type LinePath } from './connectorLineLooks.js';
import { SHIELD_WALL_CORE_COLOR, SHIELD_WALL_DOWN_COLOR, SHIELD_WALL_GLOW_COLOR } from './connectorVisual.js';

/** The deck fence link look: `old` = the power cable, `new` = a shield beam. */
export type FenceLook = 'old' | 'new';

/** What every player sees until the owner approves the new look. */
export const DEFAULT_FENCE_LOOK: FenceLook = 'new'; // owner picked the shield beam 2026-11-26

/** `?fenceLook=old|new`; absent or unknown = {@link DEFAULT_FENCE_LOOK}. */
export function readFenceLook(search: string): FenceLook {
  const m = /[?&]fenceLook=(old|new)\b/.exec(search);
  return m ? (m[1] as FenceLook) : DEFAULT_FENCE_LOOK;
}

const isFenceKind = (k: string | undefined): boolean => k === DECK_FENCE_POST_KIND || k === DECK_FENCE_GATE_KIND;

const EA = { kind: '', x: 0, y: 0 };
const EB = { kind: '', x: 0, y: 0 };

/** Is the link a–b (game space) a deck fence link: two posts on one seam, or
 *  a gate and a post on its seam's end? Callers gate on the room's deck flag.
 *  Anchor links, anchor–post taps and building cables never are. */
export function isDeckFenceLink(a: SwarmRenderState, b: SwarmRenderState): boolean {
  if (!isFenceKind(a.shipKind) || !isFenceKind(b.shipKind)) return false;
  EA.kind = a.shipKind!; EA.x = a.x; EA.y = a.y;
  EB.kind = b.shipKind!; EB.x = b.x; EB.y = b.y;
  const k = deckLinkKind(EA, EB);
  return k === DECK_LINK_SEAM_FENCE || k === DECK_LINK_SEAM_GATE;
}

/** Is the fence wall on this link up: both ends built with their walls up
 *  (the derived walls' blocking rule, `visitDerivedWalls`)? */
export function fenceBeamUp(a: StructureRenderState, b: StructureRenderState | undefined): boolean {
  return a.built && a.wallActive === true && b !== undefined && b.built && b.wallActive === true;
}

/** Beam glow width, rail offset and rail width, × the cable look's width. */
export const FENCE_BEAM_GLOW = 2.4;
export const FENCE_BEAM_RAIL_OFFSET = 0.6;
export const FENCE_BEAM_RAIL = 0.24;
/** A down wall's single line, × the cable look's width. */
export const FENCE_BEAM_DOWN = 0.45;

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: LinePath, color: number, alpha: number, width: number): void {
  _style.color = color; _style.alpha = alpha; _style.width = width;
  g.stroke(_style);
}

/**
 * One fence beam (pixi space) from post (`ax`, `ay`) to post (`bx`, `by`),
 * stopping just outside each end (`ra` / `rb`: the ends' radii, as the
 * cable's fence-link collars). Up: a cyan glow band and two rails (two
 * strokes). Down: one dim red line (one stroke).
 */
export function drawFenceBeamBody(
  g: LinePath, ax: number, ay: number, bx: number, by: number, scale: number, ra: number, rb: number, up: boolean,
): void {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const e0 = Math.min(ra * 0.9, len * 0.3), e1 = Math.min(rb * 0.9, len * 0.3);
  const x0 = ax + ux * e0, y0 = ay + uy * e0, x1 = bx - ux * e1, y1 = by - uy * e1;
  const w = cableLookWidth(scale);
  if (!up) {
    g.moveTo(x0, y0); g.lineTo(x1, y1);
    stroke(g, SHIELD_WALL_DOWN_COLOR, 0.6, w * FENCE_BEAM_DOWN);
    return;
  }
  g.moveTo(x0, y0); g.lineTo(x1, y1);
  stroke(g, SHIELD_WALL_GLOW_COLOR, 0.3, w * FENCE_BEAM_GLOW);
  const nx = -uy * w * FENCE_BEAM_RAIL_OFFSET, ny = ux * w * FENCE_BEAM_RAIL_OFFSET;
  g.moveTo(x0 + nx, y0 + ny); g.lineTo(x1 + nx, y1 + ny);
  g.moveTo(x0 - nx, y0 - ny); g.lineTo(x1 - nx, y1 - ny);
  stroke(g, SHIELD_WALL_CORE_COLOR, 0.9, w * FENCE_BEAM_RAIL);
}
