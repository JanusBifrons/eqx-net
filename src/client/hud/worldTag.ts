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
 * Allocation-free per frame except the strings written on an actual change.
 */
import type { RendererFeedback } from '../../core/contracts/render/RendererFeedback.js';
import { EMPTY_RADAR_INSETS, type RadarInsets } from '../../shared-types/settings/radar.js';
import type { PanelData } from '../components/selectionPanelData.js';
import { CONTACT_STANCE_LABEL, STANCE_COLOUR, formatContactKm } from '../components/contactRows.js';
import { distanceTextKey, placeWorldTagOnEdge, worldTagDistance, worldTagEdgeAt, worldTagWorldPoint } from './worldTagEdge.js';

/** What the tag shows (EqxWorldTag props). */
export interface WorldTagText {
  title: string;
  owner?: string;
  ownerColor?: string;
  hullPct?: number;
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

/** Set by `WorldTagHost` when the tag mode or the focus changes (low cadence). */
export function setWorldTagAnchor(anchor: WorldTagAnchor, focusId: string | null = null): void {
  _anchor = anchor;
  _focusId = focusId;
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
