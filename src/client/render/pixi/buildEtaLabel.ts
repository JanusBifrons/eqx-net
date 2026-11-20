/**
 * The build-ETA countdown drawn above a blueprint's build bar: its text, its
 * Text child and its on-screen size. Split out of `spriteBuilders.ts` (size cap).
 *
 * The label is a child of the structure sprite (so it tracks the body) but is
 * counter-scaled every frame to a CONSTANT on-screen size, like damage numbers
 * (`DamageNumbers.ts`): a 12 px world-space font read ~6 CSS px at the default
 * 0.5 zoom, unreadable on a phone.
 */
import { Text, TextStyle } from 'pixi.js';

/** On-screen size of the ETA label, CSS px (the damage numbers' first-hit size). */
export const BUILD_ETA_SCREEN_PX = 13;
/** Glyphs are rasterised at this multiple of the on-screen size and scaled
 *  DOWN, so zoom never stretches a small bitmap up (DamageNumbers' approach). */
const BUILD_ETA_RASTER_SCALE = 3;

/**
 * Phase-1 issue 2 — format the in-world build-timer ETA. `null` ⇒ stalled (no
 * minerals reaching the blueprint) → a paused marker; `undefined`/≤0 ⇒ empty
 * (built / not building). The countdown reaches 1 s granularity naturally: the
 * server recomputes `etaMs` on its 1 Hz slice, so the text ticks down ~once a
 * second with no per-frame re-raster.
 */
export function formatBuildEta(etaMs: number | null | undefined): string {
  if (etaMs === null) return '⏸'; // ⏸ stalled — no minerals
  if (etaMs === undefined || etaMs <= 0) return '';
  const totalSec = Math.ceil(etaMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

let _buildEtaStyle: TextStyle | undefined;
/** Phase-1 issue 2 — a blueprint's build-ETA countdown (a short cyan number
 *  ABOVE the body, above the construction fill-bar). Built ONCE per structure
 *  sprite (invariant #14); the caller mutates `.text` only on change and sizes
 *  it with `fitBuildEtaLabel`. Tagged `label = 'buildEta'`. */
export function buildBuildEtaText(radius: number): Text {
  _buildEtaStyle ??= new TextStyle({
    fontFamily: 'system-ui, sans-serif',
    fontSize: BUILD_ETA_SCREEN_PX * BUILD_ETA_RASTER_SCALE,
    fontWeight: '700',
    fill: 0x9fe0ff,
    stroke: { color: 0x000000, width: 3 * BUILD_ETA_RASTER_SCALE },
  });
  const t = new Text({ text: '', style: _buildEtaStyle, roundPixels: true });
  t.anchor.set(0.5, 1);
  t.y = -(radius + 16); // above the body + fill-bar (Pixi y-down)
  t.scale.set(1 / BUILD_ETA_RASTER_SCALE);
  t.label = 'buildEta';
  return t;
}

/** Counter-scale the label so it draws `BUILD_ETA_SCREEN_PX` tall on screen at
 *  `cameraScale`, whatever its parent sprite's own scale. Allocation-free. */
export function fitBuildEtaLabel(t: Text, cameraScale: number, parentScale: number): void {
  const k = Math.abs(cameraScale * parentScale);
  if (k <= 0) return;
  const s = 1 / (BUILD_ETA_RASTER_SCALE * k);
  if (t.scale.x !== s) t.scale.set(s);
}
