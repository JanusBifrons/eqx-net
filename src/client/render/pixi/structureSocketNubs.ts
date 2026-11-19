/**
 * Structure restyle 0d slice 10 — socket nubs and the inner-channel hook.
 *
 * Each structure's cable sockets (`structureSockets(kind)`, the one socket
 * list the server, the preview and the cables read) are drawn on its outline
 * as small studs in the house style of the cable collar (dark plate, cyan
 * accent): a socket with a cable in it has a lit accent and glow, a free one
 * a dark mouth. Behind the new-effects flag (`ArtOptions.fx`, `?fx=new`):
 * `SwarmSpriteCtx.socketNubs`, set by `applyRestyleLook`.
 *
 * Not a renderer of its own: the nubs are one `Graphics` child of the
 * structure's own sprite (like the rig plane group), in the sprite's local
 * Pixi frame, so they move and hide with it. The art is one shared
 * `GraphicsContext` per (kind, used-socket mask), drawn once; a structure only
 * swaps context when its used set (`connSockSelf`) changes. Per frame:
 * a WeakMap lookup and a mask walk, nothing allocated (invariant #14).
 *
 * Inner channel: how supply spreads from a socket into the building is a
 * per-family hook (`STRUCTURE_INNER_CHANNELS`), filled in by a family's own
 * look step. It is drawn into the same cached context for each USED socket,
 * under the nub. No family registers one yet: the default draws nothing.
 *
 * Shield gate / airlock sockets are their emitter posts (fence links stay
 * straight post to post): the post is the socket, so they get no nub.
 */
import { Graphics, GraphicsContext, type Container } from 'pixi.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { CABLE_SOCKET_MASK_BITS, socketListMask } from '../../../core/structures/cableCurve.js';
import {
  isStructureKindId, structureSockets, type MutStructureSocket, type StructureKindId, type StructureSocket,
} from '../../../shared-types/structureKinds.js';
import { SOCKET_ACCENT, SOCKET_OUTLINE, SOCKET_PLATE, SOCKET_PLATE_HI } from './connectorCables.js';
import type { LinePath } from './connectorLineLooks.js';
import { STRUCTURE_FAMILY, type StructureFamilyId } from './structureFamilies.js';

/** Sockets past this index have no bit in the used mask (the most any kind
 *  has today is 24). */
export const MAX_NUB_SOCKETS = CABLE_SOCKET_MASK_BITS;

/** Nub size (world units, fixed: drawn once into a shared context). Half
 *  width along the edge, depth outward past the edge and inward under it. */
export const NUB_HALF_WIDTH = 9;
export const NUB_OUT = 6;
export const NUB_IN = 4;

/** Kinds whose sockets are emitter posts, not outline studs. */
function postSocketKind(kind: string): boolean {
  return kind === 'shield_gate' || kind === 'shield_airlock';
}

/** Bit mask of the sockets this structure has a cable in (its own end of
 *  each link, `connSockSelf`). Alloc-free. */
export function socketUsedMask(connSockSelf: readonly number[] | undefined): number {
  return socketListMask(connSockSelf); // the one mask the server's socket pick uses
}

/** A socket in the structure's local PIXI frame (y down): game local (x, y)
 *  and normal flipped. Under the sprite's transform (position (cx, -cy),
 *  rotation -angle) this lands on `structureSocketToWorld`, Y-flipped. */
export function socketNubLocal(s: StructureSocket, out: MutStructureSocket): MutStructureSocket {
  out.x = s.x;
  out.y = -s.y;
  out.nx = s.nx;
  out.ny = -s.ny;
  return out;
}

// ── Inner-channel hook ──────────────────────────────────────────────────────

/**
 * A family's inner channel: draw, into `g`, the path supply takes from a
 * USED socket into the building. `sock` is in the structure's local Pixi
 * frame (`socketNubLocal`: y down, outward normal (nx, ny)); `index` is the
 * socket's index in `structureSockets(kind)`. Drawn once per (kind, used
 * mask) into a shared context, under the nub: static art, no per-frame state.
 */
export type InnerChannelHook = (g: LinePath, sock: Readonly<MutStructureSocket>, index: number, kind: StructureKindId) => void;

/** The default: no inner channel. */
export const noInnerChannel: InnerChannelHook = () => {};

/** Per-family inner channels, registered by a family's own look file. Empty
 *  until a family's look step fills one in. */
export const STRUCTURE_INNER_CHANNELS: Partial<Record<StructureFamilyId, InnerChannelHook>> = {};

/** The inner-channel hook for a kind (its family's, else `noInnerChannel`). */
export function innerChannelFor(kind: string): InnerChannelHook {
  if (!isStructureKindId(kind)) return noInnerChannel;
  return STRUCTURE_INNER_CHANNELS[STRUCTURE_FAMILY[kind]] ?? noInnerChannel;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const _style = { color: 0, alpha: 0, width: 0 };
function stroke(g: LinePath, color: number, alpha: number, width: number): void {
  _style.color = color; _style.alpha = alpha; _style.width = width;
  g.stroke(_style);
}

/** One nub at local socket `s` (Pixi frame): an outlined plate straddling the
 *  edge, a lit top edge, and the mouth at its outer face: lit cyan with a
 *  glow when `used`, a dark slot with a dim accent when free. */
export function drawSocketNub(g: LinePath, s: Readonly<MutStructureSocket>, used: boolean): void {
  const nx = s.nx, ny = s.ny, tx = -ny, ty = nx;
  const hw = NUB_HALF_WIDTH;
  // Plate: the band from NUB_IN inside the edge to NUB_OUT outside it.
  const ix = s.x - nx * NUB_IN, iy = s.y - ny * NUB_IN;
  const ox = s.x + nx * NUB_OUT, oy = s.y + ny * NUB_OUT;
  g.moveTo(ix, iy).lineTo(ox, oy); stroke(g, SOCKET_OUTLINE, 1, hw * 2 + 3);
  g.moveTo(ix, iy).lineTo(ox - nx, oy - ny); stroke(g, SOCKET_PLATE, 1, hw * 2);
  // Lit edge on the plate's light side (top-left, as the collar).
  const side = tx * 0.6 + ty * 0.8 < 0 ? 1 : -1;
  const ex = tx * hw * 0.82 * side, ey = ty * hw * 0.82 * side;
  g.moveTo(ix - ex, iy - ey).lineTo(ox - nx * 1.5 - ex, oy - ny * 1.5 - ey); stroke(g, SOCKET_PLATE_HI, 0.35, 1.2);
  // The mouth across the outer face.
  const mx = s.x + nx * (NUB_OUT - 2), my = s.y + ny * (NUB_OUT - 2);
  const mh = hw * 0.62;
  if (used) {
    g.moveTo(mx - tx * mh, my - ty * mh).lineTo(mx + tx * mh, my + ty * mh); stroke(g, SOCKET_ACCENT, 0.28, 6);
    g.moveTo(mx - tx * mh, my - ty * mh).lineTo(mx + tx * mh, my + ty * mh); stroke(g, SOCKET_ACCENT, 0.95, 2.4);
  } else {
    g.moveTo(mx - tx * mh, my - ty * mh).lineTo(mx + tx * mh, my + ty * mh); stroke(g, SOCKET_OUTLINE, 1, 2.6);
    g.moveTo(mx - tx * mh, my - ty * mh).lineTo(mx + tx * mh, my + ty * mh); stroke(g, SOCKET_ACCENT, 0.22, 1);
  }
}

const _sock: MutStructureSocket = { x: 0, y: 0, nx: 0, ny: 0 };

/** Every nub of `kind` with used mask `mask`, into `g` (structure-local Pixi
 *  frame): the family's inner channel under each used socket, then the nubs. */
export function drawSocketNubs(g: LinePath, kind: string, mask: number): void {
  if (postSocketKind(kind)) return;
  const list = structureSockets(kind);
  const channel = innerChannelFor(kind);
  if (channel !== noInnerChannel && isStructureKindId(kind)) {
    for (let i = 0; i < list.length && i < MAX_NUB_SOCKETS; i++) {
      if ((mask >>> i) & 1) channel(g, socketNubLocal(list[i]!, _sock), i, kind);
    }
  }
  for (let i = 0; i < list.length; i++) {
    drawSocketNub(g, socketNubLocal(list[i]!, _sock), i < MAX_NUB_SOCKETS && ((mask >>> i) & 1) === 1);
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

const CONTEXTS = new Map<string, GraphicsContext>();

/** Test hook: how many (kind, mask) contexts have been drawn. */
export const nubStats = { contextBuilds: 0, swaps: 0 };

/** The shared nub art for (kind, mask), drawn on first use. Cold path (a
 *  structure's used set changed): the key string is built only here. */
export function socketNubContext(kind: string, mask: number): GraphicsContext {
  const key = kind + ':' + mask;
  let ctx = CONTEXTS.get(key);
  if (ctx === undefined) {
    ctx = new GraphicsContext();
    drawSocketNubs(ctx, kind, mask);
    CONTEXTS.set(key, ctx);
    nubStats.contextBuilds++;
  }
  return ctx;
}

interface NubState { g: Graphics; kind: string; mask: number }

/** Per structure sprite: its nub child and what it was drawn for. Dies with
 *  the sprite (a rebuilt sprite gets a fresh child). */
const STATES = new WeakMap<Container, NubState>();

/** The nub child of `sprite`, or undefined (tests). */
export function socketNubsOf(sprite: Container): Graphics | undefined {
  return STATES.get(sprite)?.g;
}

/**
 * Keep `sprite`'s socket nubs in step with its kind and used sockets (the
 * structure row `st`). Called per visible structure per frame under the flag;
 * swaps the shared context only when the kind or the used mask changed.
 */
export function updateSocketNubs(sprite: Container, kind: string | undefined, st: StructureRenderState | undefined): void {
  if (kind === undefined) return;
  const mask = socketUsedMask(st?.connSockSelf);
  const s = STATES.get(sprite);
  if (s !== undefined && !s.g.destroyed && s.g.parent === sprite) {
    if (s.kind === kind && s.mask === mask) return;
    s.g.context = socketNubContext(kind, mask);
    s.kind = kind;
    s.mask = mask;
    nubStats.swaps++;
    return;
  }
  const g = new Graphics(socketNubContext(kind, mask));
  g.label = 'socketNubs';
  // Over the body art, under the build-ETA text and the mount cluster.
  const eta = sprite.getChildByLabel('buildEta');
  if (eta !== null && eta.parent === sprite) sprite.addChildAt(g, sprite.getChildIndex(eta));
  else sprite.addChild(g);
  STATES.set(sprite, { g, kind, mask });
}
