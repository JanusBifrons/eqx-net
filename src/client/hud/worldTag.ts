/**
 * Selection HUD S6b: the floating world tag over the focus (`EqxWorldTag`).
 * Text comes from React at the panel poll rate (`WorldTagHost`); the position
 * follows the focus per frame by direct DOM writes from `gameRafLoop`
 * (`updateWorldTag`), written ONLY when the rounded value changed, never a
 * React re-render (the `structures/placementHints.ts` pattern). The anchor
 * is the renderer's `focusScreenX/Y` (top-centre of the selection bracket,
 * `render/selectionTag.ts`). Hidden off screen and when nothing is focused.
 * Allocation-free per frame except the transform string on an actual move.
 */
import type { RendererFeedback } from '../../core/contracts/render/RendererFeedback.js';
import type { PanelData } from '../components/selectionPanelData.js';
import { CONTACT_STANCE_LABEL, STANCE_COLOUR } from '../components/contactRows.js';

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

/** The renderer feedback the per-frame writer reads (the centroid only for a group tag). */
export type WorldTagFeedback = Pick<RendererFeedback, 'focusScreenX' | 'focusScreenY' | 'focusOnScreen'> &
  Partial<Pick<RendererFeedback, 'selCentroidScreenX' | 'selCentroidScreenY' | 'selCentroidOnScreen'>>;

/** Pure, alloc-free: should the tag show, and where (writes {@link worldTagAt}).
 *  Hidden when the anchor is absent (NaN) or off screen. */
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

/** The mounted tag wrapper (set by `WorldTagHost`'s ref), and what was last written. */
let _el: HTMLElement | null = null;
let _shown = false;
let _x = NaN;
let _y = NaN;
let _anchor: WorldTagAnchor = 'focus';

/** Set by `WorldTagHost` when the tag mode changes (low cadence). */
export function setWorldTagAnchor(anchor: WorldTagAnchor): void {
  _anchor = anchor;
}

export function setWorldTagElement(el: HTMLElement | null): void {
  _el = el;
  _shown = false;
  _x = NaN;
  _y = NaN;
  if (el) el.style.visibility = 'hidden';
}

/** Per frame (gameRafLoop): follow the anchor; style writes on change only. */
export function updateWorldTag(fb: WorldTagFeedback): void {
  const el = _el;
  if (el === null) return;
  const show = worldTagPos(fb, _anchor);
  if (show !== _shown) {
    _shown = show;
    el.style.visibility = show ? 'visible' : 'hidden';
  }
  if (!show) return;
  const x = worldTagAt.x;
  const y = worldTagAt.y;
  if (x === _x && y === _y) return;
  _x = x;
  _y = y;
  // The tag's bottom-centre (its pointer tip) sits on the bracket's top-centre.
  el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
}
