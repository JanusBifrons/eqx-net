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
import { sendBreakIn, sendBreakInCancel, sendCargoMove, sendCargoQuery, sendSetFreightOrders } from '../net/tradeClient';
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods';
import { cargoRows, type CargoRow } from './cargoRows';
import { MAX_FREIGHT_ORDERS, type CargoItems, type FreightOrder } from '../../shared-types/messages/cargoMessages';

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

const INPUT_SX = {
  fontSize: 9, background: 'rgba(10,30,24,0.8)', color: '#d6efe4', border: '1px solid rgba(110,200,160,0.4)',
  borderRadius: '3px', padding: '1px 2px',
} as const;

/** T4b — a player's own Freight Dock: standing orders NPC convoys fill. */
function FreightOrders({ entityId, orders }: { entityId: number; orders: FreightOrder[] }): JSX.Element {
  const [good, setGood] = useState<GoodId>('minerals');
  const [mode, setMode] = useState<'import' | 'export'>('import');
  const [level, setLevel] = useState(100);
  const save = (next: FreightOrder[]): void => { sendSetFreightOrders(entityId, next); };
  const add = (): void => {
    const lv = Math.max(1, Math.min(100_000, Math.floor(level) || 1));
    save([...orders.filter((o) => o.good !== good), { good, mode, level: lv }].slice(-MAX_FREIGHT_ORDERS));
  };
  return (
    <Box data-testid="freight-orders">
      <Box sx={PANE_TITLE_SX}>Standing orders (convoys fill them)</Box>
      <Box sx={LIST_SX}>
        {orders.length === 0 && <Box sx={EMPTY_SX}>None</Box>}
        {orders.map((o) => (
          <Box key={o.good} sx={ROW_SX} data-testid="freight-order" data-good={o.good} data-mode={o.mode} data-level={o.level}>
            <Box sx={LABEL_SX}>
              {GOOD_DEFS[o.good].displayName}: {o.mode === 'import' ? `buy up to ${o.level}` : `sell above ${o.level}`}
            </Box>
            <Box sx={BTN_SX} data-testid="freight-order-remove" onClick={() => save(orders.filter((x) => x.good !== o.good))}>×</Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: '3px', alignItems: 'center', mt: '3px' }}>
        <select data-testid="freight-order-good" style={INPUT_SX} value={good} onChange={(e) => setGood(e.target.value as GoodId)}>
          {GOOD_IDS.map((g) => <option key={g} value={g}>{GOOD_DEFS[g].displayName}</option>)}
        </select>
        <Box sx={BTN_SX} data-testid="freight-order-mode" onClick={() => setMode(mode === 'import' ? 'export' : 'import')}>
          {mode === 'import' ? 'Buy up to' : 'Sell above'}
        </Box>
        <input
          data-testid="freight-order-level" style={{ ...INPUT_SX, width: 44 }} type="number" min={1} max={100000}
          value={level} onChange={(e) => setLevel(Number(e.target.value))}
        />
        <Box sx={BTN_SX} data-testid="freight-order-add" onClick={add}>Add</Box>
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
      {state !== null && !state.open && state.breakIn !== undefined && (
        // C2 — breaking in is a hostile act: the owner's turrets will engage you.
        state.breakIn.pct === null ? (
          <Box sx={{ display: 'flex', gap: '3px', alignItems: 'center', mt: '3px' }}>
            <Box sx={BTN_SX} data-testid="cargo-break-in" onClick={() => sendBreakIn(entityId)}>
              Break in · {Math.round(state.breakIn.durationMs / 1000)}s
            </Box>
            <Box sx={EMPTY_SX}>hostile: their turrets will fire</Box>
          </Box>
        ) : (
          <Box data-testid="cargo-break-in-progress" data-pct={Math.round(state.breakIn.pct * 100)} sx={{ mt: '3px' }}>
            <Box>Breaking in… {Math.round(state.breakIn.pct * 100)}%</Box>
            <Box sx={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', my: '2px' }}>
              <Box sx={{ height: '100%', width: `${Math.round(state.breakIn.pct * 100)}%`, backgroundColor: '#ff8f6b' }} />
            </Box>
            <Box sx={BTN_SX} data-testid="cargo-break-in-cancel" onClick={() => sendBreakInCancel()}>Stop</Box>
          </Box>
        )
      )}
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
      {state?.open === true && state.orders !== undefined && <FreightOrders entityId={entityId} orders={state.orders} />}
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
