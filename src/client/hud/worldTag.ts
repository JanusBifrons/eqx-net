/**
 * Selection HUD S6b: the floating world tag over the focus (`EqxWorldTag`).
 * Text comes from React at the panel poll rate (`WorldTagHost`); the position
 * follows the focus per frame by direct DOM writes from `gameRafLoop`
 * (`updateWorldTag`), written ONLY when the rounded value changed, never a
 * React re-render (the `structures/placementHints.ts` pattern). The anchor
 * is the renderer's `focusScreenX/Y` (top-centre of the selection bracket,
 * `render/selectionTag.ts`). Hidden when nothing is focused. Off screen (S9)
 * it sticks to the screen edge with an arrow + distance (`worldTagEdge.ts`)
 * and a tap glides the camera there.
 * S10: at far zoom the tag goes compact (one line, type name + owner dot) by
 * the far-zoom icon rule, `isIconOnly(diam, wasIconOnly)` with its hysteresis
 * (`render/farIconRule.ts`): a `data-compact` flip on change, no React render.
 * Allocation-free per frame except the strings written on an actual change.
 */
import type { RendererFeedback } from '../../core/contracts/render/RendererFeedback.js';
import { EMPTY_RADAR_INSETS, type RadarInsets } from '../../shared-types/settings/radar.js';
import type { PanelData } from '../components/selectionPanelData.js';
import { CONTACT_STANCE_LABEL, STANCE_COLOUR, formatContactKm } from '../components/contactRows.js';
import { isIconOnly } from '../render/farIconRule.js';
import { distanceTextKey, placeWorldTagOnEdge, worldTagDistance, worldTagEdgeAt, worldTagWorldPoint } from './worldTagEdge.js';

/** What the tag shows (EqxWorldTag props). */
export interface WorldTagText {
  title: string;
  owner?: string;
  ownerColor?: string;
  hullPct?: number;
  /** The compact (far zoom, S10) line when it differs from `title`. */
  compactTitle?: string;
}

/**
 * Pure: the tag's lines from the focus's panel data. `typeName` is the hull
 * type ("Fighter") for a ship whose name is its pilot; it is dropped when it
 * repeats the name. Line 2 is the owner ("you", their name) or, without one,
 * the stance word; coloured by stance. No bar for a rock or a pending read.
 */
export function worldTagText(data: PanelData, typeName: string | undefined): WorldTagText {
  const title = typeName !== undefined && typeName !== '' && typeName !== data.name ? `${typeName} · ${data.name}` : data.name;
  const out: WorldTagText = { title };
  const owner = data.owner ?? (data.stance !== undefined ? CONTACT_STANCE_LABEL[data.stance] : undefined);
  if (owner !== undefined) out.owner = owner;
  if (data.stance !== undefined) out.ownerColor = STANCE_COLOUR[data.stance];
  if (data.noHull !== true && data.pending !== true) out.hullPct = data.hpPct;
  if (title !== data.name && typeName !== undefined) out.compactTitle = typeName;
  return out;
}

/** Result scratch of {@link worldTagPos}: rounded screen px of the tag's pointer tip. */
export const worldTagAt = { x: 0, y: 0 };

/** What the tag hangs over (S7): the focus's bracket, or the selected
 *  ships' centroid (the group tag, {@link GROUP_TAG_LIFT_PX} above it). */
export type WorldTagAnchor = 'focus' | 'centroid';

/** The group tag's fixed lift above the selection centroid (screen px). */
export const GROUP_TAG_LIFT_PX = 36;

/** The renderer feedback the per-frame writer reads (the centroid only for a
 *  group tag; the diameter and the view only for the edge-stuck tag, S9). */
export type WorldTagFeedback = Pick<RendererFeedback, 'focusScreenX' | 'focusScreenY' | 'focusOnScreen'> &
  Partial<Pick<RendererFeedback, 'selCentroidScreenX' | 'selCentroidScreenY' | 'selCentroidOnScreen'
    | 'focusScreenDiam' | 'viewX' | 'viewY' | 'viewHalf'>>;

/** Pure, alloc-free: should the tag show over its anchor, and where (writes
 *  {@link worldTagAt}). False when the anchor is absent (NaN) or off screen. */
export function worldTagPos(
  fb: WorldTagFeedback,
  anchor: WorldTagAnchor = 'focus',
): boolean {
  const group = anchor === 'centroid';
  const x = group ? fb.selCentroidScreenX ?? NaN : fb.focusScreenX;
  const y = group ? (fb.selCentroidScreenY ?? NaN) - GROUP_TAG_LIFT_PX : fb.focusScreenY;
  const on = group ? fb.selCentroidOnScreen === true : fb.focusOnScreen;
  if (!on || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  worldTagAt.x = Math.round(x);
  worldTagAt.y = Math.round(y);
  return true;
}

/** Result scratch of {@link worldTagCentre}: the anchor's centre, screen px. */
export const worldTagCentreAt = { x: 0, y: 0 };

/** Pure, alloc-free: the anchored thing's screen centre, on screen or not
 *  (the focus's bracket top lowered by its radius; the bare centroid). */
export function worldTagCentre(fb: WorldTagFeedback, anchor: WorldTagAnchor = 'focus'): boolean {
  const group = anchor === 'centroid';
  const x = group ? fb.selCentroidScreenX ?? NaN : fb.focusScreenX;
  const y = group ? fb.selCentroidScreenY ?? NaN : fb.focusScreenY + (fb.focusScreenDiam ?? 0) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  worldTagCentreAt.x = x;
  worldTagCentreAt.y = y;
  return true;
}

/**
 * Pure: the on-screen diameter (px) the compact switch (S10) judges, or NaN
 * when unknown. A single tag: the focus's own (`focusScreenDiam`). The group
 * tag has no per-group diameter, so: the focus's when one of the group is
 * focused, else the largest selected hull (`groupRadiusU`, game units) at the
 * camera zoom, taken from `viewHalf` (the larger half of the visible world)
 * against the larger half of the `w × h` screen. The group goes compact
 * only once its biggest ship would be icon-only.
 */
export function worldTagCompactDiam(
  fb: WorldTagFeedback, anchor: WorldTagAnchor, focusId: string | null, groupRadiusU: number, w: number, h: number,
): number {
  if (anchor === 'focus' || focusId !== null) return fb.focusScreenDiam ?? NaN;
  const viewHalf = fb.viewHalf ?? 0;
  if (!(viewHalf > 0) || !(groupRadiusU > 0)) return NaN;
  return (groupRadiusU * Math.max(w, h)) / viewHalf;
}

/** The camera glide a tap on the edge-stuck tag fires (the pilot-swap glide's length). */
export const WORLD_TAG_GLIDE_MS = 420;

/** The renderer surface the tap needs (`IRenderer.glideCameraTo`). */
export interface WorldTagCamera {
  glideCameraTo(gameX: number, gameY: number, durationMs: number, toScale?: number): void;
}

/** The mounted tag wrapper (set by `WorldTagHost`'s ref), and what was last written. */
let _el: HTMLElement | null = null;
let _shown = false;
let _x = NaN;
let _y = NaN;
let _anchor: WorldTagAnchor = 'focus';
let _focusId: string | null = null;
/** S10 compact state: the rule's hysteresis memory, what the DOM holds (-1 = unwritten), the group's hull radius. */
let _iconOnly = false;
let _compactDom = -1;
let _groupRadiusU = 0;
let _root: HTMLElement | null = null;
/** S9 edge-stuck state: the tag's parts, measured half size, last arrow/distance. */
let _edge = false;
let _edgeRow: HTMLElement | null = null;
let _arrow: HTMLElement | null = null;
let _dist: HTMLElement | null = null;
let _pointer: HTMLElement | null = null;
let _halfW = 0;
let _halfH = 0;
let _deg = NaN;
let _distKey = NaN;
let _glideReq = false;
let _hud: RadarInsets = EMPTY_RADAR_INSETS;
const _glideAt = { x: 0, y: 0 };

/** Set by `WorldTagHost` when the tag mode, the focus or the group's largest
 *  hull radius (game units, S10) changes (low cadence). */
export function setWorldTagAnchor(anchor: WorldTagAnchor, focusId: string | null = null, groupRadiusU = 0): void {
  _anchor = anchor;
  _focusId = focusId;
  _groupRadiusU = groupRadiusU;
}

/** Is the tag compact now (the rule's current verdict, S10)? */
export function worldTagCompact(): boolean {
  return _iconOnly;
}

/** The HUD rects the edge-stuck tag keeps clear of (App.tsx, 2 Hz, on change). */
export function setWorldTagHudInsets(insets: RadarInsets): void {
  _hud = insets;
}

/** A tap on the edge-stuck tag: the next frame glides the camera to its anchor. */
export function requestWorldTagGlide(): void {
  _glideReq = true;
}

function part(el: HTMLElement, attr: string): HTMLElement | null {
  return typeof el.querySelector === 'function' ? el.querySelector<HTMLElement>(`[${attr}]`) : null;
}

export function setWorldTagElement(el: HTMLElement | null): void {
  _el = el;
  _shown = false;
  _x = NaN;
  _y = NaN;
  _edge = false;
  _deg = NaN;
  _distKey = NaN;
  _glideReq = false;
  _compactDom = -1;
  _root = el ? part(el, 'data-world-tag') : null;
  _edgeRow = el ? part(el, 'data-world-tag-edge') : null;
  _arrow = el ? part(el, 'data-world-tag-arrow') : null;
  _dist = el ? part(el, 'data-world-tag-dist') : null;
  _pointer = el ? part(el, 'data-world-tag-pointer') : null;
  if (el) el.style.visibility = 'hidden';
}

/** Re-read the tag's size (on entering edge mode or a distance text change). */
function measure(el: HTMLElement): void {
  _halfW = (el.offsetWidth || 0) / 2;
  _halfH = (el.offsetHeight || 0) / 2;
}

/** Enter / leave edge mode: the arrow + distance row shows, the down pointer
 *  hides, and the tag takes taps (pointer events ONLY while edge-stuck). */
function setEdge(el: HTMLElement, edge: boolean): void {
  _edge = edge;
  _x = NaN;
  _y = NaN;
  _deg = NaN;
  _distKey = NaN;
  if (_edgeRow) _edgeRow.style.display = edge ? 'flex' : 'none';
  if (_pointer) _pointer.style.display = edge ? 'none' : '';
  el.style.pointerEvents = edge ? 'auto' : 'none';
  el.style.cursor = edge ? 'pointer' : '';
  if (el.dataset) el.dataset['edge'] = edge ? '1' : '0';
  if (edge) measure(el);
}

/** Edge mode, per frame: arrow angle + distance text, written on change only. */
function writeEdgeParts(el: HTMLElement, cx: number, cy: number, w: number, h: number, viewHalf: number): void {
  const deg = Math.round((worldTagEdgeAt.angle * 180) / Math.PI);
  if (deg !== _deg && _arrow) {
    _deg = deg;
    _arrow.style.transform = `rotate(${deg}deg)`;
  }
  const d = worldTagDistance(cx, cy, w, h, viewHalf);
  const key = distanceTextKey(d);
  if (key !== _distKey && _dist) {
    _distKey = key;
    _dist.textContent = formatContactKm(d);
    measure(el);
  }
}

/** S10, per shown frame: run the icon-only rule (with hysteresis) and flip
 *  the tag's `data-compact` on change only; edge-stuck, re-measure. */
function writeCompact(el: HTMLElement, fb: WorldTagFeedback, w: number, h: number): void {
  const diam = worldTagCompactDiam(fb, _anchor, _focusId, _groupRadiusU, w, h);
  if (Number.isFinite(diam)) _iconOnly = isIconOnly(diam, _iconOnly);
  const c = _iconOnly ? 1 : 0;
  if (c === _compactDom) return;
  _compactDom = c;
  if (_root) _root.setAttribute('data-compact', c === 1 ? '1' : '0');
  if (_edge) measure(el);
}

/**
 * Per frame (gameRafLoop): follow the anchor; style writes on change only.
 * Off screen (S9) the tag sticks to the screen edge (`w × h`, the window)
 * pointing at it; a queued tap glides `cam` there. Returns the focus id while
 * a single tag is edge-stuck (the radar skips that entity's own edge arrow,
 * `RenderMirror.worldTagEdgeId`), else null.
 */
export function updateWorldTag(fb: WorldTagFeedback, w = 0, h = 0, cam?: WorldTagCamera): string | null {
  const el = _el;
  const glide = _glideReq;
  _glideReq = false;
  if (el === null) return null;
  const on = worldTagPos(fb, _anchor);
  const centre = !on && worldTagCentre(fb, _anchor);
  const cx = worldTagCentreAt.x;
  const cy = worldTagCentreAt.y;
  let edge = centre && placeWorldTagOnEdge(cx, cy, w, h, _halfW, _halfH, _hud);
  if (edge !== _edge) {
    setEdge(el, edge);
    // Re-place with the measured size (the first edge frame had none).
    if (edge) edge = placeWorldTagOnEdge(cx, cy, w, h, _halfW, _halfH, _hud);
  }
  const show = on || edge;
  if (show !== _shown) {
    _shown = show;
    el.style.visibility = show ? 'visible' : 'hidden';
  }
  if (!show) return null;
  writeCompact(el, fb, w, h);
  if (edge) {
    writeEdgeParts(el, cx, cy, w, h, fb.viewHalf ?? 0);
    if (glide && cam && worldTagWorldPoint(cx, cy, w, h, fb.viewX ?? 0, fb.viewY ?? 0, fb.viewHalf ?? 0, _glideAt)) {
      cam.glideCameraTo(_glideAt.x, _glideAt.y, WORLD_TAG_GLIDE_MS);
    }
  }
  const x = edge ? Math.round(worldTagEdgeAt.x) : worldTagAt.x;
  const y = edge ? Math.round(worldTagEdgeAt.y) : worldTagAt.y;
  if (x !== _x || y !== _y) {
    _x = x;
    _y = y;
    // On screen the tag's bottom-centre (its pointer tip) sits on the bracket's
    // top-centre; edge-stuck its centre sits on the edge track.
    el.style.transform = edge
      ? `translate(${x}px, ${y}px) translate(-50%, -50%)`
      : `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
  return edge && _anchor === 'focus' ? _focusId : null;
}
