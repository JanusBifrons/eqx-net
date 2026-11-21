/**
 * The connector web's STATIC layer (A3, plan soft-leaping-truffle v2): idle
 * edges, built-turret range rings, up-wall rails and open-iris guides, drawn
 * BEHIND `ConnectorRenderer.gfx` and rebuilt only when something it draws
 * changes. Line widths are screen-constant, so the layer is drawn at a
 * half-octave zoom key (`staticScaleKey`) and a key change redraws it.
 *
 * Zoom without full-base rebuilds (perf/connector-zoom-rebuild): the layer is
 * split into spatial CHUNKS (`STATIC_CHUNK_CELL` world units square, by the
 * structure that owns each line). Per chunk:
 *  - off screen ⇒ hidden and NOT redrawn on a key change (it catches up the
 *    first frame it comes on screen);
 *  - each drawn key's `GraphicsContext` is kept (the last
 *    `STATIC_CHUNK_KEYS`), so zooming back to a key already drawn swaps the
 *    context in: no redraw and no re-tessellation (Pixi keeps a context's GPU
 *    geometry until the context changes).
 * Every chunk on screen is always drawn at the live key, so the look is
 * exactly the old single-Graphics layer at every zoom.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { visitDerivedWalls, type DerivedWallVisitor } from '../../structures/derivedWalls.js';
import { CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';
import { builtRangeCircleVisualInto, connectorVisualInto, staticScaleKey, type ConnectorVisual, type RingVisual } from './connectorVisual.js';
import { drawLineLookBody, type LineLook } from './connectorLineLooks.js';
import { drawSocketCableBody, type LinkCable, type LinkCableCache } from './connectorCables.js';

/** Chunk cell size (world units). A phone at the far end of the stall band
 *  (viewHalf 2048) sees a few cells across; at viewHalf 512, about one. */
export const STATIC_CHUNK_CELL = 1024;
/** Zoom keys kept per chunk (each a drawn `GraphicsContext`). */
export const STATIC_CHUNK_KEYS = 6;
/** Slack around a chunk's drawn box before it counts as off screen. */
const VIEW_PAD = 64;

/** FNV-1a style integer mix. */
function mix(h: number, n: number): number {
  return Math.imul(h ^ (n | 0), 16777619);
}

/**
 * Integer signature of everything the static layer draws: the structure set and
 * poses, connections, built / walls-up state, and the highlighted
 * turret. Alloc-free (key iteration + scalar maths).
 */
export function staticSignature(
  structures: ReadonlyMap<number, StructureRenderState>,
  swarm: ReadonlyMap<number, SwarmRenderState>,
  highlighted: number | null | undefined,
): number {
  let h = mix(2166136261, structures.size);
  h = mix(h, highlighted ?? -1);
  for (const id of structures.keys()) {
    const st = structures.get(id)!;
    const a = swarm.get(id);
    h = mix(h, id);
    if (a) {
      h = mix(h, Math.round(a.x));
      h = mix(h, Math.round(a.y));
      h = mix(h, Math.round(a.angle * 1000));
    } else {
      h = mix(h, -7);
    }
    h = mix(h, (st.built ? 1 : 0) | (st.wallActive ? 2 : 0) | (st.mirror === true ? 4 : 0));
    const conn = st.connTo;
    h = mix(h, conn.length);
    for (let c = 0; c < conn.length; c++) h = mix(h, conn[c]!);
    // 0d slice 8: a socket change re-lays that link's cable.
    const ss = st.connSockSelf, so = st.connSockOther;
    if (ss) for (let c = 0; c < ss.length; c++) h = mix(h, ss[c]!);
    if (so) for (let c = 0; c < so.length; c++) h = mix(h, so[c]!);
  }
  return h;
}

/** Link `c` of structure `id` (the lower-id end, pose `a`) to pose `b`: its
 *  cached cable between the stored sockets (each end's build mirror from its row). */
export function linkCableOf(
  cables: LinkCableCache, id: number, st: StructureRenderState, c: number,
  a: SwarmRenderState, b: SwarmRenderState, rows: ReadonlyMap<number, StructureRenderState>,
): LinkCable {
  const o = st.connTo[c]!;
  return cables.get(id * 65536 + o, a, st.connSockSelf?.[c] ?? CABLE_NO_SOCKET, b, st.connSockOther?.[c] ?? CABLE_NO_SOCKET, st.mirror === true, rows.get(o)?.mirror === true);
}

/** Is any point of cable `c`, padded by `pad`, inside the pixi-space view rect? No bounds ⇒ yes. */
export function cableInView(c: LinkCable, pad: number, bounds: Float64Array | undefined): boolean {
  if (!bounds) return true;
  const p = c.poly;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.n; i++) {
    const x = p[i * 2]!, y = p[i * 2 + 1]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 + pad >= bounds[0]! && x0 - pad <= bounds[2]! && y1 + pad >= bounds[1]! && y0 - pad <= bounds[3]!;
}

/** What the static layer reads from its renderer. */
export interface StaticLayerHost {
  readonly highlightedStructureId: number | null;
  readonly turretOverlays: boolean;
  readonly socketCables: boolean;
  readonly lineLook: LineLook | null;
  readonly cables: LinkCableCache;
  /** Draw the walls here (false while the new fences own them). */
  readonly staticWalls: boolean;
  /** The steady part of one derived wall into `g` (pixi space), at `scale`. */
  drawSteadyWall(g: Graphics, ax: number, ay: number, bx: number, by: number, blocking: boolean, open: boolean, scale: number): void;
}

interface Chunk {
  readonly g: Graphics;
  /** Zoom key of the context `g` shows (NaN = nothing current). */
  key: number;
  /** Structures in the chunk (0 ⇒ hidden). */
  members: number;
  /** Pixi-space box of everything the chunk draws. */
  x0: number; y0: number; x1: number; y1: number;
  /** Range-ring readouts (key-independent; the width follows the key). */
  rings: number; ringRadius: number; ringHl: boolean;
  /** Scratch: redraw this frame. */
  build: boolean;
  /** Kept contexts and their keys, least recently shown first. */
  readonly keys: number[];
  readonly ctxs: GraphicsContext[];
}

function cellOf(px: number, py: number): number {
  return (Math.floor(px / STATIC_CHUNK_CELL) + 32768) * 65536 + (Math.floor(py / STATIC_CHUNK_CELL) + 32768);
}

function grow(ch: Chunk, x: number, y: number, r: number): void {
  if (x - r < ch.x0) ch.x0 = x - r;
  if (y - r < ch.y0) ch.y0 = y - r;
  if (x + r > ch.x1) ch.x1 = x + r;
  if (y + r > ch.y1) ch.y1 = y + r;
}

/** Move kept slot `i` to the most-recent end (in place, no allocation). */
function touch(ch: Chunk, i: number): void {
  const k = ch.keys[i]!, c = ch.ctxs[i]!;
  for (let j = i; j < ch.keys.length - 1; j++) { ch.keys[j] = ch.keys[j + 1]!; ch.ctxs[j] = ch.ctxs[j + 1]!; }
  ch.keys[ch.keys.length - 1] = k;
  ch.ctxs[ch.ctxs.length - 1] = c;
}

export class ConnectorStaticLayer {
  /** Added to the scene behind the per-frame layer; one child per chunk. */
  readonly container = new Container();
  /** Test hooks: frames that redrew anything, chunks redrawn, and
   *  structures whose static lines were redrawn (the tessellation work). */
  rebuilds = 0;
  chunkBuilds = 0;
  structuresDrawn = 0;
  /** Readouts over the chunks on screen (ConnectorRenderer publishes them). */
  ringCount = 0;
  ringRadius = 0;
  ringWidth = 0;

  private readonly chunks = new Map<number, Chunk>();
  private _sig = Number.NaN;
  private _key = Number.NaN;
  private readonly _edge: ConnectorVisual = {
    color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0,
    pulseActive: false, pulseT: 0, pulseColor: 0, pulseAlpha: 0, pulseWidth: 0,
  };
  private readonly _ring: RingVisual = { color: 0, alpha: 0, width: 0 };
  private _drawScale = 1;
  /** Layout pass: grows each wall's chunk box. */
  private readonly _boxWalls: DerivedWallVisitor = {
    wall: (_key, ax, ay, bx, by) => {
      const ch = this.chunks.get(cellOf(ax, -ay));
      if (!ch) return;
      grow(ch, ax, -ay, 32);
      grow(ch, bx, -by, 32);
    },
  };
  /** Draw pass: each wall into its chunk, if that chunk is being redrawn. */
  private readonly _drawWalls: DerivedWallVisitor = {
    wall: (_key, ax, ay, bx, by, blocking, _thickness, open) => {
      const ch = this.chunks.get(cellOf(ax, -ay));
      if (ch && ch.build) this.host.drawSteadyWall(ch.g, ax, -ay, bx, -by, blocking, open, this._drawScale);
    },
  };

  constructor(private readonly host: StaticLayerHost) {}

  /** Something the signature cannot see changed: redraw everything. */
  invalidate(): void { this._sig = Number.NaN; }

  /** No structures: hide every chunk and forget the drawn state. */
  clear(): void {
    if (this._sig !== this._sig) return; // NaN ⇒ already clear
    this._sig = Number.NaN;
    for (const ch of this.chunks.values()) { ch.g.visible = false; ch.members = 0; ch.key = Number.NaN; }
    this.ringCount = 0;
    this.ringRadius = 0;
    this.ringWidth = 0;
    this.host.cables.clear();
  }

  /**
   * Per frame: re-lay the chunks if the signature changed, then make every
   * on-screen chunk show the live zoom key (a kept context, else a redraw).
   * `sigExtra` folds renderer-level switches (fences, cables) into the signature.
   */
  refresh(
    structures: ReadonlyMap<number, StructureRenderState>,
    swarm: ReadonlyMap<number, SwarmRenderState>,
    scale: number,
    view: Float64Array | undefined,
    sigExtra: number,
  ): void {
    const host = this.host;
    const sig = staticSignature(structures, swarm, host.highlightedStructureId) + sigExtra;
    if (sig !== this._sig) {
      this._sig = sig;
      this.layout(structures, swarm);
    }
    const key = staticScaleKey(scale, this._key);
    this._key = key;
    let need = 0;
    for (const ch of this.chunks.values()) {
      ch.build = false;
      if (ch.members === 0) { ch.g.visible = false; continue; }
      const vis = !view || (ch.x1 + VIEW_PAD >= view[0]! && ch.x0 - VIEW_PAD <= view[2]! && ch.y1 + VIEW_PAD >= view[1]! && ch.y0 - VIEW_PAD <= view[3]!);
      ch.g.visible = vis;
      if (!vis || ch.key === key) continue;
      const i = ch.keys.indexOf(key);
      if (i >= 0) {
        ch.g.context = ch.ctxs[i]!;
        ch.key = key;
        touch(ch, i);
        continue;
      }
      ch.build = true;
      need++;
    }
    if (need > 0) this.draw(structures, swarm, key, need);
    // Readouts over the chunks on screen.
    this.ringCount = 0;
    this.ringRadius = 0;
    this.ringWidth = 0;
    let hl = false;
    for (const ch of this.chunks.values()) {
      if (!ch.g.visible || ch.rings === 0) continue;
      this.ringCount += ch.rings;
      this.ringRadius = ch.ringRadius;
      hl = ch.ringHl;
    }
    if (this.ringCount > 0) {
      const w = builtRangeCircleVisualInto(this._ring, Math.pow(2, key / 2)).width;
      this.ringWidth = hl ? w * 3 : w;
    }
  }

  /** Signature changed: forget every kept key, re-assign structures to
   *  chunks and re-measure each chunk's box (and sweep the cable cache). */
  private layout(structures: ReadonlyMap<number, StructureRenderState>, swarm: ReadonlyMap<number, SwarmRenderState>): void {
    const host = this.host;
    for (const ch of this.chunks.values()) {
      ch.members = 0;
      ch.key = Number.NaN;
      for (let i = 0; i < ch.keys.length; i++) ch.keys[i] = Number.NaN;
      ch.x0 = Infinity; ch.y0 = Infinity; ch.x1 = -Infinity; ch.y1 = -Infinity;
    }
    const cables = host.socketCables;
    if (cables) host.cables.beginSweep();
    for (const id of structures.keys()) {
      const st = structures.get(id)!;
      const a = swarm.get(id);
      if (!a) continue;
      const ax = a.x, ay = -a.y;
      const cell = cellOf(ax, ay);
      let ch = this.chunks.get(cell);
      if (!ch) {
        const g = new Graphics();
        g.visible = false;
        this.container.addChild(g);
        ch = {
          g, key: Number.NaN, members: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
          rings: 0, ringRadius: 0, ringHl: false, build: false, keys: [], ctxs: [],
        };
        this.chunks.set(cell, ch);
      }
      ch.members++;
      grow(ch, ax, ay, a.radius + 16);
      if (st.built && a.shipKind !== undefined && isStructureKindId(a.shipKind)) {
        const wr = getStructureKind(a.shipKind).weaponRange;
        if (wr !== undefined && wr > 0) grow(ch, ax, ay, wr + 16);
      }
      const conn = st.connTo;
      for (let c = 0; c < conn.length; c++) {
        const otherId = conn[c]!;
        if (id > otherId) continue;
        const b = swarm.get(otherId);
        if (!b) continue;
        grow(ch, b.x, -b.y, b.radius + 16);
        if (cables) {
          const cab = linkCableOf(host.cables, id, st, c, a, b, structures);
          for (let i = 0; i < cab.n; i++) grow(ch, cab.poly[i * 2]!, cab.poly[i * 2 + 1]!, 16);
        }
      }
    }
    if (cables) host.cables.endSweep();
    else if (host.cables.size > 0) host.cables.clear();
    if (host.staticWalls) visitDerivedWalls(structures, swarm, this._boxWalls);
  }

  /** Redraw every chunk flagged `build`, at `key`, in one walk. */
  private draw(
    structures: ReadonlyMap<number, StructureRenderState>,
    swarm: ReadonlyMap<number, SwarmRenderState>,
    key: number,
    need: number,
  ): void {
    const host = this.host;
    this.rebuilds++;
    this.chunkBuilds += need;
    for (const ch of this.chunks.values()) {
      if (!ch.build) continue;
      // A free slot gets a new context; else the least recently shown one is reused.
      let ctx: GraphicsContext;
      if (ch.keys.length < STATIC_CHUNK_KEYS) {
        ctx = new GraphicsContext();
        ch.keys.push(key);
        ch.ctxs.push(ctx);
      } else {
        touch(ch, 0);
        ctx = ch.ctxs[ch.ctxs.length - 1]!;
        ch.keys[ch.keys.length - 1] = key;
        ctx.clear();
      }
      ch.g.context = ctx;
      ch.key = key;
      ch.rings = 0;
      ch.ringRadius = 0;
      ch.ringHl = false;
    }
    const scale = Math.pow(2, key / 2);
    this._drawScale = scale;
    // Idle look of every edge (an edge carrying flow is overdrawn per frame).
    const idle = connectorVisualInto(this._edge, 0, 0, scale);
    const cables = host.socketCables;
    const look = host.lineLook;
    for (const id of structures.keys()) {
      const st = structures.get(id)!;
      const a = swarm.get(id);
      if (!a) continue;
      const ax = a.x;
      const ay = -a.y;
      const ch = this.chunks.get(cellOf(ax, ay));
      if (!ch || !ch.build) continue;
      const g = ch.g;
      this.structuresDrawn++;
      // WS-D (#21) — always-on defensive RANGE circle for a BUILT weapon turret.
      if (host.turretOverlays && st.built && a.shipKind !== undefined && isStructureKindId(a.shipKind)) {
        const wr = getStructureKind(a.shipKind).weaponRange;
        if (wr !== undefined && wr > 0) {
          const rc = builtRangeCircleVisualInto(this._ring, scale);
          // Phase 5 — bolder ring when this turret is hovered/selected.
          const highlighted = id === host.highlightedStructureId;
          g.circle(ax, ay, wr);
          g.stroke({ color: rc.color, alpha: highlighted ? Math.min(1, rc.alpha * 2.6) : rc.alpha, width: highlighted ? rc.width * 3 : rc.width });
          ch.rings++;
          ch.ringRadius = wr;
          ch.ringHl = highlighted;
        }
      }
      const conn = st.connTo;
      for (let c = 0; c < conn.length; c++) {
        const otherId = conn[c]!;
        if (id > otherId) continue; // each undirected edge once
        const b = swarm.get(otherId);
        if (!b) continue;
        if (cables) { drawSocketCableBody(g, linkCableOf(host.cables, id, st, c, a, b, structures), scale, a.radius, b.radius); continue; }
        if (look) { drawLineLookBody(g, look, ax, ay, b.x, -b.y, scale, a.radius, b.radius); continue; }
        g.moveTo(ax, ay).lineTo(b.x, -b.y);
        g.stroke({ color: idle.color, alpha: idle.alpha, width: idle.width });
      }
    }
    if (host.staticWalls) visitDerivedWalls(structures, swarm, this._drawWalls);
  }

  destroy(): void {
    for (const ch of this.chunks.values()) {
      ch.g.destroy();
      for (const c of ch.ctxs) c.destroy();
    }
    this.chunks.clear();
    this.container.destroy();
  }
}
