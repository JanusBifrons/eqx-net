/**
 * Structure cable sockets (structure-restyle stage 4, 0d): where a cable may
 * attach to a structure, per kind, in local GAME space (Y-up, centred,
 * unrotated: the same frame as `structureOutline`).
 *
 * ONE socket source for the server, the build preview and both renderers. Each
 * socket is a point on the outline edge plus the edge's unit OUTWARD normal
 * (the direction a cable leaves in).
 *
 * Rules, in order:
 *   1. A per-kind override (`STRUCTURE_SOCKET_OVERRIDES`), filled by a
 *      family's own file when its look step needs a bespoke layout. Empty today.
 *   2. Shield gate / airlock: the emitter POSTS (`gatePosts.ts`, the same data
 *      `emitterAnchor` uses), normal pointing from the centre through the post.
 *      Fence links stay straight post to post, so these are post centres, not
 *      outline points.
 *   3. Connector: the six faces of its hex, one socket per face midpoint. A
 *      connector takes cables from ANY side, so its socket count is not a link
 *      limit (a levelled connector reaches 10 links on 6 faces).
 *   4. Default: sockets on the kind's (unstyled) `structureOutline` edges,
 *      `ceil(len / STRUCTURE_SOCKET_SPACING)` per edge (at least one), evenly
 *      spaced at segment midpoints. On a concave outline an edge segment whose
 *      outward ray runs back into the building (a pocket) gets no socket.
 *
 * Sockets use the UNSTYLED outline (no `styleId`), because the server has no
 * style: a style that re-seeds the outline draws its nubs from this list.
 */
import { GATE_POSTS, AIRLOCK_POSTS } from './gatePosts.js';
import { DEFAULT_STRUCTURE_KIND, isStructureKindId } from './lookup.js';
import { structureOutline } from './outline.js';
import type { StructureKindId } from './types.js';

/** One cable socket, local space: position (x, y) and unit outward normal (nx, ny). */
export interface StructureSocket {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

/** A caller-owned scratch socket (for the rotated / world-space form). */
export interface MutStructureSocket {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** Default spacing (world units) along an outline edge: one socket per started
 *  300 u, so an edge up to 300 u gets one socket at its midpoint, 300–600 u two,
 *  and so on. */
export const STRUCTURE_SOCKET_SPACING = 300;

/** Per-kind override: a family file registers a bespoke socket list here. Empty
 *  until a family's look step needs one. */
export const STRUCTURE_SOCKET_OVERRIDES: Partial<Record<StructureKindId, readonly StructureSocket[]>> = {};

type P = { x: number; y: number };

function freezeSocket(x: number, y: number, nx: number, ny: number): StructureSocket {
  return Object.freeze({ x, y, nx, ny });
}

/** Does the ray from (px, py) along (dx, dy) hit any outline edge other than
 *  edge `skip` (within `maxT`)? Used to drop sockets in concave pockets. */
function rayHitsOutline(poly: readonly P[], skip: number, px: number, py: number, dx: number, dy: number, maxT: number): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = a.x - px;
    const wy = a.y - py;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t > 1e-6 && t <= maxT && u >= 0 && u <= 1) return true;
  }
  return false;
}

function postSockets(posts: readonly (readonly [number, number])[]): readonly StructureSocket[] {
  return Object.freeze(
    posts.map(([x, y]) => {
      const len = Math.hypot(x, y) || 1;
      return freezeSocket(x, y, x / len, y / len);
    }),
  );
}

function outlineSockets(id: StructureKindId): readonly StructureSocket[] {
  const poly = structureOutline(id);
  const n = poly.length;
  const oneFace = id === 'connector';
  // Ray reach for the pocket test: past the whole outline.
  let reach = 0;
  for (const p of poly) reach = Math.max(reach, Math.hypot(p.x, p.y));
  reach *= 4;
  const out: StructureSocket[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    // CCW outline ⇒ outward normal is the edge direction turned clockwise.
    const nx = ey / len;
    const ny = -ex / len;
    const count = oneFace ? 1 : Math.max(1, Math.ceil(len / STRUCTURE_SOCKET_SPACING));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const x = a.x + ex * t;
      const y = a.y + ey * t;
      if (rayHitsOutline(poly, i, x, y, nx, ny, reach)) continue;
      out.push(freezeSocket(x, y, nx, ny));
    }
  }
  return Object.freeze(out);
}

const CACHE = new Map<StructureKindId, readonly StructureSocket[]>();

/**
 * A kind's cable sockets in local space (see the module doc for the rules).
 * Returns a CACHED, frozen array: built on the kind's first call, then
 * allocation-free, so hot paths may call it every frame. Unknown kind ⇒ the
 * Capital's sockets (the `getStructureKind` stance). Rotate with
 * `rotateStructureSocket` / `structureSocketToWorld`.
 */
export function structureSockets(kindId: string | null | undefined): readonly StructureSocket[] {
  const id = kindId != null && isStructureKindId(kindId) ? kindId : DEFAULT_STRUCTURE_KIND;
  let list = CACHE.get(id);
  if (list === undefined) {
    list =
      STRUCTURE_SOCKET_OVERRIDES[id] ??
      (id === 'shield_gate' ? postSockets(GATE_POSTS)
        : id === 'shield_airlock' ? postSockets(AIRLOCK_POSTS)
          : outlineSockets(id));
    CACHE.set(id, list);
  }
  return list;
}

/** Rotate one socket by `angle` (radians, CCW in Y-up game space, the
 *  `localToWorld` convention) into `out`. Alloc-free. */
export function rotateStructureSocket(s: StructureSocket, angle: number, out: MutStructureSocket): MutStructureSocket {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const x = s.x * c - s.y * sn;
  const y = s.x * sn + s.y * c;
  const nx = s.nx * c - s.ny * sn;
  const ny = s.nx * sn + s.ny * c;
  out.x = x;
  out.y = y;
  out.nx = nx;
  out.ny = ny;
  return out;
}

/** One socket of a structure at (cx, cy) rotated by `angle`, in world space,
 *  into `out`. Alloc-free. */
export function structureSocketToWorld(
  s: StructureSocket,
  cx: number, cy: number, angle: number,
  out: MutStructureSocket,
): MutStructureSocket {
  rotateStructureSocket(s, angle, out);
  out.x += cx;
  out.y += cy;
  return out;
}
