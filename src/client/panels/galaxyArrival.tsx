/**
 * The Galaxy panel's Arrival section (UI language plan U2-2a; moved from the
 * old drawer's GalaxyTab): where the ship lands when you warp to another sector.
 *
 *  - **X/Y**  editable target coords, clamped to ±SECTOR_PLAYABLE_HALF_EXTENT on
 *             blur; a clamp shows a short note under the fields.
 *  - **Same** read-only: the local ship's current x/y, polled from the render
 *             mirror every 5 s while the panel is open (never Zustand:
 *             invariant #2). The server falls back to the departure pose.
 *  - **Home** read-only: the persisted per-user home coord.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { EqxSection, EqxSegmented, EqxTextField } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';
import { useUIStore, type ArrivalMode } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { SECTOR_PLAYABLE_HALF_EXTENT, clampToSectorBounds } from '../../shared-types/sectorBounds';

const POLL_INTERVAL_MS = 5_000;
/** How long the clamp note stays up. */
export const CLAMP_NOTE_MS = 3_500;

const MODE_OPTIONS = [
  { id: 'xy', label: 'X/Y' },
  { id: 'same', label: 'Same' },
  { id: 'home', label: 'Home' },
] as const;

const INPUTS_ROW_STYLE: CSSProperties = { display: 'flex', gap: HUD.panel.bodyGap };
const HINT_STYLE: CSSProperties = { fontFamily: HUD.font.label, fontSize: HUD.list.rowSmallFont, color: HUD.color.inkDim };
const NOTE_STYLE: CSSProperties = { ...HINT_STYLE, color: HUD.color.manual };

/** Format a number for the input: integers bare, else two decimals. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** The local ship's x/y every 5 s while `on` (component state, not Zustand). */
function useShipSnapshot(on: boolean): { x: number; y: number } | null {
  const [snapshot, setSnapshot] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!on) { setSnapshot(null); return undefined; }
    const read = (): void => {
      const c = getGameClient();
      const id = c?.mirror.localPlayerId;
      const ship = id ? c?.mirror.ships.get(id) : null;
      setSnapshot(ship ? { x: ship.x, y: ship.y } : null);
    };
    read();
    const handle = window.setInterval(read, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [on]);
  return snapshot;
}

export function GalaxyArrivalSection({ shown, inTransit }: { shown: boolean; inTransit: boolean }): JSX.Element {
  const arrivalMode = useUIStore((s) => s.arrivalMode);
  const arrivalTargetX = useUIStore((s) => s.arrivalTargetX);
  const arrivalTargetY = useUIStore((s) => s.arrivalTargetY);
  const homePosX = useUIStore((s) => s.homePosX);
  const homePosY = useUIStore((s) => s.homePosY);
  const setArrivalMode = useUIStore((s) => s.setArrivalMode);
  const setArrivalTarget = useUIStore((s) => s.setArrivalTarget);
  const snapshot = useShipSnapshot(shown && arrivalMode === 'same');

  // String buffers so the player can type "-" or "-5" mid-edit; re-synced
  // from the store on a mode change or an outside update (clamp, rehydrate).
  const [xInput, setXInput] = useState('0');
  const [yInput, setYInput] = useState('0');
  useEffect(() => {
    const x = arrivalMode === 'xy' ? arrivalTargetX : arrivalMode === 'home' ? homePosX : snapshot?.x ?? 0;
    const y = arrivalMode === 'xy' ? arrivalTargetY : arrivalMode === 'home' ? homePosY : snapshot?.y ?? 0;
    setXInput(formatNumber(x));
    setYInput(formatNumber(y));
  }, [arrivalMode, arrivalTargetX, arrivalTargetY, homePosX, homePosY, snapshot]);

  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    if (!clamped) return undefined;
    const t = window.setTimeout(() => setClamped(false), CLAMP_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [clamped]);

  const onMode = useCallback((id: string) => { setClamped(false); setArrivalMode(id as ArrivalMode); }, [setArrivalMode]);
  const onX = useCallback((v: string) => { setClamped(false); setXInput(v); }, []);
  const onY = useCallback((v: string) => { setClamped(false); setYInput(v); }, []);

  const commitXY = (): void => {
    if (arrivalMode !== 'xy') return;
    const xRaw = parseFloat(xInput);
    const yRaw = parseFloat(yInput);
    const result = clampToSectorBounds(Number.isFinite(xRaw) ? xRaw : 0, Number.isFinite(yRaw) ? yRaw : 0);
    setArrivalTarget(result.x, result.y);
    setXInput(formatNumber(result.x));
    setYInput(formatNumber(result.y));
    if (result.clamped) setClamped(true);
  };

  const xyEditable = arrivalMode === 'xy' && !inTransit;
  return (
    <EqxSection title="Arrival" data-testid="galaxy-arrival">
      <EqxSegmented options={MODE_OPTIONS} value={arrivalMode} onChange={onMode} label="Arrival point"
        disabled={inTransit} data-testid="arrival-mode" />
      <div style={INPUTS_ROW_STYLE}>
        <EqxTextField label="Arrival X" value={xInput} onChange={onX} onBlur={commitXY} inputMode="decimal"
          disabled={!xyEditable} data-testid="arrival-x-input" />
        <EqxTextField label="Arrival Y" value={yInput} onChange={onY} onBlur={commitXY} inputMode="decimal"
          disabled={!xyEditable} data-testid="arrival-y-input" />
      </div>
      <div style={HINT_STYLE} data-testid="arrival-hint">
        {arrivalMode === 'xy' && `Type a target. Clamped to ±${SECTOR_PLAYABLE_HALF_EXTENT} on blur.`}
        {arrivalMode === 'same' && 'Lands at your current position when you warp. Updated every 5 s.'}
        {arrivalMode === 'home' && 'Lands at your home coord on every warp.'}
      </div>
      {clamped && (
        <div style={NOTE_STYLE} role="status" data-testid="arrival-clamp-note">
          {`Arrival clamped to sector bounds (±${SECTOR_PLAYABLE_HALF_EXTENT}).`}
        </div>
      )}
    </EqxSection>
  );
}
