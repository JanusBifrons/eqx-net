/**
 * The Power tab's grid bar and its "held" explainer.
 *
 * The client has only the grid's NET power (`netPower` on every member) and
 * this building's own figure, not the grid's total supply and draw, so the
 * bar shows what is known: this building's share (its draw, or a generator's
 * output) beside what the grid has spare (green) or is short (red). A
 * Battery also shows its own charge. No new wire data, no grid maths.
 *
 * The explainer covers a processor the server holds "unpowered" while its
 * grid reads powered: the grid cannot take its full draw at this throttle.
 */
import { Box } from '@mui/material';
import { HUD } from '../hud/tokens';
import { PROD_STATE } from '@shared-types/production';
import { signed, type PowerSummary } from './structureSettingsPower';

export interface GridBarView {
  state: 'surplus' | 'short';
  /** This building's share: its draw, or a generator's output (≥ 0). */
  share: number;
  /** The share's width on the bar, 0..100 (%). */
  sharePct: number;
  /** "+14 spare", "−130 short". */
  label: string;
  /** "Battery 120 / 500", only on a Battery. */
  battery?: string;
}

export function gridBarView(p: PowerSummary): GridBarView {
  const share = Math.abs(p.selfPower);
  const net = p.gridNet;
  const total = share + Math.abs(net);
  const short = net < 0;
  return {
    state: short ? 'short' : 'surplus',
    share,
    sharePct: total > 0 ? (share / total) * 100 : 0,
    label: short ? `−${-net} short` : `+${net} spare`,
    battery: p.storedPowerMax !== undefined
      ? `Battery ${Math.round(p.storedPower ?? 0)} / ${Math.round(p.storedPowerMax)}`
      : undefined,
  };
}

/** True when the server holds a processor unpowered on a powered grid. */
export function powerHeld(p: PowerSummary): boolean {
  return p.on && p.powered && p.prodState === PROD_STATE.unpowered;
}

export function heldText(p: PowerSummary, throttleable: boolean): string {
  return throttleable
    ? `Not enough power to run at ${p.throttle * 10}% — lower the throttle or build Solar Panels.`
    : 'Not enough power to run — build Solar Panels.';
}

export function GridBar({ p }: { p: PowerSummary }): JSX.Element {
  const v = gridBarView(p);
  const tone = v.state === 'short' ? C.hullCrit : C.hullOk;
  return (
    <Box sx={WRAP_SX} data-testid="settings-power-bar" data-state={v.state} data-net={p.gridNet} data-share={v.share}>
      <Box sx={HEAD_SX}>
        <Box sx={{ color: C.inkDim }}>This building {signed(p.selfPower)}</Box>
        <Box sx={{ color: tone, fontWeight: 700 }} data-testid="settings-power-bar-label">{v.label}</Box>
      </Box>
      <Box sx={{ ...TRACK_SX, borderColor: tone }}>
        <Box sx={{ ...SEG_SX, width: `${v.sharePct}%`, bgcolor: C.auto }} />
        <Box sx={{ ...SEG_SX, flex: 1, bgcolor: tone, opacity: 0.75 }} />
        {v.share > 0 && <Box sx={{ ...MARK_SX, left: `${v.sharePct}%` }} data-testid="settings-power-bar-marker" />}
      </Box>
      {v.battery !== undefined && <Box sx={BATTERY_SX} data-testid="settings-power-battery">{v.battery}</Box>}
    </Box>
  );
}

export function HeldNote({ p, throttleable }: { p: PowerSummary; throttleable: boolean }): JSX.Element | null {
  if (!powerHeld(p)) return null;
  return <Box sx={HELD_SX} data-testid="settings-power-held">{heldText(p, throttleable)}</Box>;
}

const C = HUD.color;
// The bar and the note sit first in the Power grid (order -1), full width.
const WRAP_SX = { gridColumn: '1 / -1', order: -1, mb: 0.5 } as const;
const HEAD_SX = { display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums', mb: 0.5 } as const;
const TRACK_SX = { position: 'relative' as const, display: 'flex', height: 10, border: '1px solid', borderRadius: '2px', overflow: 'hidden', bgcolor: C.cell } as const;
const SEG_SX = { height: '100%' } as const;
const MARK_SX = { position: 'absolute' as const, top: 0, bottom: 0, width: 2, ml: '-1px', bgcolor: C.ink } as const;
const BATTERY_SX = { fontSize: 11, color: C.inkDim, mt: 0.5, fontFamily: HUD.font.num } as const;
const HELD_SX = { gridColumn: '1 / -1', order: -1, fontSize: 12, color: C.hullWarn, lineHeight: 1.35 } as const;
