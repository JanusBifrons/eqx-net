/**
 * The connector palette: the idle line colour and the colour of each flow
 * material (the resource a link carries), with its lightened pulse colour.
 * Split out of `connectorVisual.ts` (which re-exports all of it) to keep that
 * file under the 600-line ceiling. Pure, no Pixi.
 */
/** Idle (non-flowing) line tint — muted blue. */
export const CONNECTOR_IDLE_COLOR = 0x4488aa;
/** Idle line ALPHA (Equinox Phase-5 audit — "connection lines lit up for no
 *  reason"). Power flow is aggregated, never flashed, so a working grid sits at
 *  IDLE — and 0.3 read as fully "lit". Dropped to a faint 0.14 so an idle edge is
 *  a subtle "this is connected" hint, and only an edge carrying minerals / repair
 *  / construction flow (the ACTIVE branch, alpha ≥ 0.6 + glow) reads as LIT. */
export const CONNECTOR_IDLE_ALPHA = 0.14;
/** Mineral-flow tint (hauling ore / reclaiming) — orange. */
export const CONNECTOR_MINERAL_COLOR = 0xee8844;
/** WS-D (#12) — repair / healing flow tint — green. */
export const CONNECTOR_REPAIR_COLOR = 0x55dd66;
/** WS-D (#12) — construction / build flow tint — cyan. */
export const CONNECTOR_CONSTRUCTION_COLOR = 0x44ccdd;
/** Power-flow tint (reserved — power is aggregated, not flashed, in Phase 3). */
export const CONNECTOR_POWER_COLOR = 0x44ddff;

/** WS-D (#12) — the per-edge flow material a `grid_pulse` carries. Mirrors the
 *  wire `GridFlowMaterial` (kept local so `connectorVisual` stays import-light;
 *  the renderer maps the wire string into this). */
export type ConnectorFlowMaterial = 'power' | 'minerals' | 'repair' | 'construction';

/** WS-D (#12) — pack a flow material into the numeric code stored on
 *  `RenderMirror.gridFlowMaterial` (no per-frame string handling / cheap
 *  structured-clone across the worker boundary). */
export function flowMaterialToCode(material: ConnectorFlowMaterial): number {
  switch (material) {
    case 'repair': return 1;
    case 'construction': return 2;
    case 'power': return 3;
    case 'minerals':
    default: return 0;
  }
}

/** WS-D (#12) — unpack the numeric mirror code back to a flow material (renderer
 *  read path). Unknown / absent ⇒ minerals (back-compat default). */
export function codeToFlowMaterial(code: number | undefined): ConnectorFlowMaterial {
  switch (code) {
    case 1: return 'repair';
    case 2: return 'construction';
    case 3: return 'power';
    default: return 'minerals';
  }
}

/** WS-D (#12) — the ACTIVE (flowing) base tint for a flow material. Idle is the
 *  muted blue (the absence of a flash), handled by the idle branch — never here. */
export function activeColorFor(material: ConnectorFlowMaterial): number {
  switch (material) {
    case 'repair': return CONNECTOR_REPAIR_COLOR;
    case 'construction': return CONNECTOR_CONSTRUCTION_COLOR;
    case 'power': return CONNECTOR_POWER_COLOR;
    case 'minerals':
    default: return CONNECTOR_MINERAL_COLOR;
  }
}

/** Blend two 0xRRGGBB colours (`t` = 0 ⇒ `a`). */
export function mixColor(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

/** The colour of the resource a link carries (the connector palette above);
 *  no material (an idle link) = the idle colour. A cable wears it on its
 *  glow and core while it flows (owner 2026-11-21: colour = resource). */
export function flowMaterialColor(material: ConnectorFlowMaterial | undefined): number {
  return material === undefined ? CONNECTOR_IDLE_COLOR : activeColorFor(material);
}

/** How far a material's flow pulse (comets, sparks, collar ring) is lifted
 *  toward white: the same hue as the material, bright enough to read as a
 *  moving packet over the glow. */
const PULSE_LIFT = 0.55;
const PULSE_MINERALS = mixColor(CONNECTOR_MINERAL_COLOR, 0xffffff, PULSE_LIFT);
const PULSE_REPAIR = mixColor(CONNECTOR_REPAIR_COLOR, 0xffffff, PULSE_LIFT);
const PULSE_CONSTRUCTION = mixColor(CONNECTOR_CONSTRUCTION_COLOR, 0xffffff, PULSE_LIFT);
const PULSE_POWER = mixColor(CONNECTOR_POWER_COLOR, 0xffffff, PULSE_LIFT);

/** A material's flow-pulse colour: its palette colour lightened. */
export function flowPulseColor(material: ConnectorFlowMaterial): number {
  switch (material) {
    case 'repair': return PULSE_REPAIR;
    case 'construction': return PULSE_CONSTRUCTION;
    case 'power': return PULSE_POWER;
    case 'minerals':
    default: return PULSE_MINERALS;
  }
}
