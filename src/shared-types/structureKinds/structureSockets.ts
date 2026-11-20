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
 *   1. A per-kind override (`STRUCTURE_SOCKET_OVERRIDES`): a bespoke list for a
 *      kind whose drawn art does not fill its outline (see there; a family's
 *      look step drops its entry once it draws the outline deck).
 *   2. Shield gate / airlock: the emitter POSTS (`gatePosts.ts`, the same data
 *      `emitterAnchor` uses), normal pointing from the centre through the post.
 *      Fence links stay straight post to post, so these are post centres, not
 *      outline points.
 *   2b. Teleporter pads (`TELEPORTER_KINDS`): the pad is open and its POSTS
 *      are the only solid parts (`padPostCenters`), so one socket per post,
 *      on the post's outer face (the footprint edge), normal straight out.
 *   3. Connector: the six faces of its hex, one socket per face midpoint. A
 *      connector takes cables from ANY side, so its socket count is not a link
 *      limit (a levelled connector reaches 10 links on 6 faces).
 *   4. Default: sockets on the edges of the kind's house-look outline
 *      (`structureOutline(kind, SOCKET_OUTLINE_STYLE)`, the edge players see),
 *      `ceil(len / STRUCTURE_SOCKET_SPACING)` per edge (at least one), evenly
 *      spaced at segment midpoints. On a concave outline an edge segment whose
 *      outward ray runs back into the building (a pocket) gets no socket. On a
 *      chamfered outline (every non-hex family in the house look) the short
 *      cut-corner edges get no socket (owner: "drop corner studs"), except on
 *      a shield pylon, which takes any side.
 *   5. Landing pads: a kind with a `keepClear` pad (the freight dock, the
 *      Capital's crane bay) has NO socket on its pad side (owner: no
 *      connector overlapping the pad ships land on). Every outline edge
 *      facing the pad is dropped whole, and so is any socket sitting on the
 *      pad or whose outward ray runs into it. The pad is solid to cables
 *      too (`isCablePolylineBlocked`, core `cableCurve.ts`).
 *
 * Sockets sit on the HOUSE-LOOK outline (style `c`, the clean symmetric
 * chamfer players see), not the seeded unstyled one: the server has no style,
 * but a stud must sit on the edge the player sees (stud audit). The outline is
 * shared pure data, so server and client still agree.
 */
import { GATE_POSTS, AIRLOCK_POSTS } from './gatePosts.js';
import { DEFAULT_STRUCTURE_KIND, getStructureKind, isStructureKindId } from './lookup.js';
import { PAD_SPECS, TELEPORTER_KINDS, padPostCenters, type TeleporterKind } from '../teleport.js';
import { STRUCTURE_OUTLINE_FAMILY, structureOutline } from './outline.js';
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

/** The structure style whose outline the sockets sit on: the house look
 *  (`DEFAULT_STRUCT_STYLE` in client artMode.ts; a test keeps them equal). */
export const SOCKET_OUTLINE_STYLE = 'c';

type P = { x: number; y: number };

function freezeSocket(x: number, y: number, nx: number, ny: number): StructureSocket {
  return Object.freeze({ x, y, nx, ny });
}

/**
 * Per-kind override: a bespoke socket list for a kind whose drawn art (today's
 * plan in client `structureVisuals.ts`; no style C drawer yet) leaves its
 * outline edge empty, so outline studs would float in space (stud audit).
 * Each stud sits on a solid edge of that art, long sides only, one per started
 * `STRUCTURE_SOCKET_SPACING`. When the kind's family gets its style C look
 * (which draws the outline deck), drop its entry so it returns to rule 4.
 */
export const STRUCTURE_SOCKET_OVERRIDES: Partial<Record<StructureKindId, readonly StructureSocket[]>> = {
  // Armoured emplacement: a square plate (the hex outline is never drawn).
  missile_turret: Object.freeze([
    freezeSocket(95, 0, 1, 0), freezeSocket(0, 95, 0, 1), freezeSocket(-95, 0, -1, 0), freezeSocket(0, -95, 0, -1),
  ]),
  // Rail gun: the 270 u carriage block (396 u long: two a side) and the two
  // rail ends; the railed runs between are rungs over a 210 u spine.
  siege_gun_80cm: Object.freeze([
    freezeSocket(0, -450, 0, -1),
    freezeSocket(135, -99, 1, 0), freezeSocket(135, 99, 1, 0),
    freezeSocket(0, 450, 0, 1),
    freezeSocket(-135, 99, -1, 0), freezeSocket(-135, -99, -1, 0),
  ]),
  // The spire: the broadcast spine's two ends and the plinth edge past the
  // lantern tower's two ends (400 x 300 plinth); the antenna fins between
  // them are open.
  territory_lock: Object.freeze([
    freezeSocket(200, 0, 1, 0), freezeSocket(0, 150, 0, 1), freezeSocket(-200, 0, -1, 0), freezeSocket(0, -150, 0, -1),
  ]),
};

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

type PadBox = { cx: number; cy: number; w: number; h: number };

/** Does outline edge a→b (outward normal nx, ny) face the pad: the pad lies
 *  in front of the edge line (along the normal) and overlaps the edge's span
 *  along the edge? Such an edge is the pad side: no socket on it at all. */
function edgeFacesPad(pad: PadBox, a: P, b: P, nx: number, ny: number): boolean {
  const hx = pad.w / 2, hy = pad.h / 2;
  // The pad's far extent along the normal, measured from the edge line.
  const along = (pad.cx - a.x) * nx + (pad.cy - a.y) * ny;
  if (along + hx * Math.abs(nx) + hy * Math.abs(ny) <= 0) return false;
  // Overlap along the edge tangent (-ny, nx) with the edge's span.
  const tx = -ny, ty = nx;
  const ea = a.x * tx + a.y * ty, eb = b.x * tx + b.y * ty;
  const pc = pad.cx * tx + pad.cy * ty, rT = hx * Math.abs(tx) + hy * Math.abs(ty);
  return pc + rT > Math.min(ea, eb) && pc - rT < Math.max(ea, eb);
}

/** Is (px, py) on or inside the pad box? */
function onPad(pad: PadBox, px: number, py: number): boolean {
  return Math.abs(px - pad.cx) <= pad.w / 2 && Math.abs(py - pad.cy) <= pad.h / 2;
}

/** Does the outward ray from (px, py) along (nx, ny) enter the keep-clear box? */
function facesPad(pad: PadBox,px: number, py: number, nx: number, ny: number): boolean {
  const hx = pad.w / 2, hy = pad.h / 2;
  let t0 = 0, t1 = Infinity;
  for (const [p, d, c, h] of [[px, nx, pad.cx, hx], [py, ny, pad.cy, hy]] as const) {
    if (Math.abs(d) < 1e-9) { if (p < c - h || p > c + h) return false; continue; }
    const a = (c - h - p) / d, b = (c + h - p) / d;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

function postSockets(posts: readonly (readonly [number, number])[]): readonly StructureSocket[] {
  return Object.freeze(
    posts.map(([x, y]) => {
      const len = Math.hypot(x, y) || 1;
      return freezeSocket(x, y, x / len, y / len);
    }),
  );
}

const SIDE_NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/** A teleporter pad: one socket per post, on its outer face. `padPostCenters`
 *  lists `posts / 4` posts per side, sides in order bottom, right, top, left. */
function padSockets(kind: TeleporterKind): readonly StructureSocket[] {
  const posts = padPostCenters(kind);
  const perSide = Math.max(1, Math.round(posts.length / 4));
  const half = PAD_SPECS[kind].post / 2;
  return Object.freeze(posts.map(([x, y], i) => {
    const [nx, ny] = SIDE_NORMALS[Math.floor(i / perSide) % 4]!;
    return freezeSocket(x + nx * half, y + ny * half, nx, ny);
  }));
}

function isPadKind(id: string): id is TeleporterKind {
  return (TELEPORTER_KINDS as readonly string[]).includes(id);
}

function outlineSockets(id: StructureKindId): readonly StructureSocket[] {
  const poly = structureOutline(id, SOCKET_OUTLINE_STYLE);
  // Rule 5: a kind with a landing pad (`keepClear`: freight dock, Capital
  // crane bay) takes no cable on its pad side (the stud would sit under the
  // hazard strip and the cable would run across the pad ships land on).
  const pad = getStructureKind(id).keepClear;
  const n = poly.length;
  const oneFace = id === 'connector';
  // House-look outlines of every non-hex family alternate cut corner, long
  // side (`symmetricChamferOutline`): the cut edges are the diagonal ones.
  // The pylon keeps them (it takes any side).
  const skipCorners = STRUCTURE_OUTLINE_FAMILY[id] !== 'hex' && id !== 'shield_pylon';
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
    if (skipCorners && Math.abs(ex) > 1e-9 && Math.abs(ey) > 1e-9) continue;
    // CCW outline ⇒ outward normal is the edge direction turned clockwise.
    const nx = ey / len;
    const ny = -ex / len;
    if (pad !== undefined && edgeFacesPad(pad, a, b, nx, ny)) continue;
    const count = oneFace ? 1 : Math.max(1, Math.ceil(len / STRUCTURE_SOCKET_SPACING));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const x = a.x + ex * t;
      const y = a.y + ey * t;
      if (rayHitsOutline(poly, i, x, y, nx, ny, reach)) continue;
      if (pad !== undefined && (onPad(pad, x, y) || facesPad(pad, x, y, nx, ny))) continue;
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
          : isPadKind(id) ? padSockets(id)
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
