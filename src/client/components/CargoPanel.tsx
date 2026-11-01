/**
 * C1 (plan soft-leaping-truffle v3) — a structure's cargo, opened from the
 * inspector. Two panes: what's in the structure ("Here") and what's in your
 * ship ("Aboard"). Take moves items aboard; Put unloads them into this
 * structure. Rebuilt ONLY from the server's `cargo_state` replies (#16): it
 * asks on mount and every second while it's on screen. The server decides
 * whether it opens (relation, range, a live ship) and says why when it doesn't.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { useUIStore } from '../state/store';
import { sendCargoMove, sendCargoQuery } from '../net/tradeClient';
import { cargoRows, type CargoRow } from './cargoRows';
import type { CargoItems } from '../../shared-types/messages/cargoMessages';

export const CARGO_POLL_MS = 1000;
/** How long a move's verdict stays on the panel. */
export const CARGO_NOTICE_MS = 3000;

const ROOT_SX = { mt: 0.5, pointerEvents: 'auto' as const, fontSize: 10, color: '#d6efe4', maxWidth: 260 };
const TITLE_SX = { fontSize: 10, fontWeight: 700, color: '#8fe0bd', mb: '2px' };
const PANE_TITLE_SX = { fontSize: 9, color: '#9fb8ad', mt: '3px' };
const LIST_SX = { display: 'flex', flexDirection: 'column' as const, gap: '2px', maxHeight: 110, overflowY: 'auto' as const };
const ROW_SX = {
  display: 'flex', alignItems: 'center', gap: '3px', px: 0.5, py: '1px', borderRadius: '3px',
  border: '1px solid rgba(110,200,160,0.3)', backgroundColor: 'rgba(10,30,24,0.6)',
};
const LABEL_SX = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const };
const BTN_SX = {
  px: 0.5, borderRadius: '3px', cursor: 'pointer', userSelect: 'none' as const, fontSize: 9,
  border: '1px solid rgba(143,224,189,0.8)', color: '#effff8', backgroundColor: 'rgba(30,90,70,0.6)',
};
const EMPTY_SX = { color: '#7f958c', fontStyle: 'italic' as const };
const WARN_SX = { color: '#ffb36b' };

/** "12¢" (whole credits) or "1.5¢" (cheap goods). */
function credits(n: number): string {
  return n >= 10 ? `${Math.round(n)}¢` : `${Math.round(n * 10) / 10}¢`;
}

function Pane({ title, rows, verb, testPrefix, onMove, prices }: {
  title: string;
  rows: CargoRow[];
  verb: 'Take' | 'Put' | 'Buy' | 'Sell';
  testPrefix: 'here' | 'aboard';
  onMove: (items: CargoItems) => void;
  /** T4 — a market: per-unit prices by good; only goods trade. */
  prices?: Partial<Record<string, number>>;
}): JSX.Element {
  const v = verb.toLowerCase();
  const priceOf = (r: CargoRow, qty: number): string => {
    if (prices === undefined) return '';
    const unit = prices[r.key.slice(2)];
    return unit === undefined ? '' : ` · ${credits(unit * qty)}`;
  };
  const tradable = (r: CargoRow): boolean => prices === undefined || (r.key.startsWith('g:') && prices[r.key.slice(2)] !== undefined);
  return (
    <Box>
      <Box sx={PANE_TITLE_SX}>{title}</Box>
      <Box sx={LIST_SX}>
        {rows.length === 0 && <Box sx={EMPTY_SX}>Empty</Box>}
        {rows.map((r) => (
          <Box key={r.key} sx={ROW_SX} data-testid={`cargo-${testPrefix}-row`} data-key={r.key} data-count={r.count}>
            <Box sx={LABEL_SX}>{r.label}{r.count > 1 ? ` ×${r.count}` : ''}</Box>
            {tradable(r) && r.count > 1 && (
              <Box sx={BTN_SX} data-testid={`cargo-${v}-one`} onClick={() => onMove(r.one)}>{verb} 1{priceOf(r, 1)}</Box>
            )}
            {tradable(r) && (
              <Box sx={BTN_SX} data-testid={`cargo-${v}-all`} onClick={() => onMove(r.all)}>{r.count > 1 ? `${verb} all` : verb}{priceOf(r, r.count)}</Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export const CargoPanel = memo(function CargoPanel({ entityId }: { entityId: number }): JSX.Element {
  const state = useUIStore((s) => (s.cargoState?.entityId === entityId ? s.cargoState : null));

  // A move's verdict rides one reply; the next poll has none. Hold it.
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state?.ok === undefined || state.message === undefined) return;
    setNotice({ ok: state.ok, message: state.message });
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), CARGO_NOTICE_MS);
  }, [state]);
  useEffect(() => () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    sendCargoQuery(entityId);
    const t = setInterval(() => sendCargoQuery(entityId), CARGO_POLL_MS);
    return () => clearInterval(t);
  }, [entityId]);

  const here = cargoRows(state?.hold ?? null);
  const aboard = cargoRows(state?.ship ?? null);
  const market = state?.market;

  return (
    <Box sx={ROOT_SX} data-testid="cargo-panel" data-open={state?.open === true ? '1' : '0'} data-market={market ? '1' : '0'}>
      <Box sx={TITLE_SX}>
        {market ? 'Market' : 'Cargo'}{state?.open === true && !market ? ` · ${Math.round(state.used)}/${state.capacity}` : ''}
      </Box>
      {state === null && <Box>Opening…</Box>}
      {state !== null && !state.open && <Box sx={WARN_SX} data-testid="cargo-locked">{state.message ?? 'Locked.'}</Box>}
      {state?.open === true && (
        <>
          <Pane
            title={market ? 'For sale' : 'Here'} rows={here} verb={market ? 'Buy' : 'Take'} testPrefix="here"
            onMove={(items) => sendCargoMove(entityId, 'take', items)} prices={market?.buy}
          />
          <Pane
            title={`Aboard · ${Math.round(state.shipCapacity)} capacity`} rows={aboard} verb={market ? 'Sell' : 'Put'} testPrefix="aboard"
            onMove={(items) => sendCargoMove(entityId, 'put', items)} prices={market?.sell}
          />
        </>
      )}
      {notice !== null && (
        <Box sx={notice.ok ? undefined : WARN_SX} data-testid="cargo-notice" data-ok={notice.ok ? '1' : '0'}>{notice.message}</Box>
      )}
    </Box>
  );
});

const TOGGLE_ROW_SX = { display: 'flex', gap: '4px', alignItems: 'center', pointerEvents: 'auto' as const, mt: 0.5 };
const TOGGLE_BTN_SX = { color: '#8fe0bd', p: 0.5 };
const TOGGLE_ICON_SX = { fontSize: { xs: 16, sm: 22 } };

/** The inspector's "Cargo" toggle for a storage structure: opens the panel
 *  (which asks the server, so a locked or far structure says why). */
export const CargoAction = memo(function CargoAction({ entityId }: { entityId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Box sx={TOGGLE_ROW_SX}>
        <Tooltip title="Open cargo">
          <IconButton data-testid="cargo-open-toggle" size="small" sx={TOGGLE_BTN_SX} onClick={() => setOpen((v) => !v)}>
            <Inventory2Icon sx={TOGGLE_ICON_SX} />
          </IconButton>
        </Tooltip>
      </Box>
      {open && <CargoPanel entityId={entityId} />}
    </Box>
  );
});
