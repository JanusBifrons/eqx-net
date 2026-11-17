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
import { sendBreakIn, sendBreakInCancel, sendCargoMove, sendCargoQuery, sendSetAutoUnload, sendSetFreightOrders, type CargoTarget } from '../net/tradeClient';
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods';
import { holdWeight } from '../../core/cargo/hold';
import { allOf, cargoRows, type CargoRow } from './cargoRows';
import { DROP_SIDE_ATTR, useTileDrag, type TileDrag } from './useTileDrag';
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

/** Tile edge per rarity, the pod beacon's grey / blue / gold. */
const TIER_EDGE = ['rgba(170,190,180,0.55)', 'rgba(110,170,255,0.85)', 'rgba(255,200,90,0.9)'] as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'repeat(5, 44px)', gap: '3px', maxHeight: 150, overflowY: 'auto' as const };
const TILE_SX = {
  position: 'relative' as const, width: 44, height: 44, boxSizing: 'border-box' as const, borderRadius: '3px', p: '2px',
  backgroundColor: 'rgba(10,30,24,0.75)', fontSize: 8, lineHeight: 1.1, overflow: 'hidden', userSelect: 'none' as const,
  wordBreak: 'break-word' as const,
};
const COUNT_SX = { position: 'absolute' as const, right: 2, bottom: 1, fontSize: 9, fontWeight: 700, color: '#effff8' };
const SPIN_SX = {
  width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(143,224,189,0.25)', borderTopColor: '#8fe0bd',
  animation: 'eqx-loot-spin 0.8s linear infinite', '@keyframes eqx-loot-spin': { to: { transform: 'rotate(360deg)' } },
};

/** Cargo pods slice 17: one side of the loot window. A tile per stack, then
 *  a "?" tile per stack still being searched (the first spins). Tap a tile to
 *  move the whole stack, or (slice 18) drag it onto the other grid; no
 *  `onMove` = look only (a peek). */
function Grid({ title, rows, hidden, testPrefix, onMove, drag }: {
  title: string;
  rows: CargoRow[];
  hidden: number;
  testPrefix: 'here' | 'aboard';
  onMove?: (items: CargoItems) => void;
  drag?: TileDrag;
}): JSX.Element {
  const qs: number[] = [];
  for (let i = 0; i < hidden; i++) qs.push(i);
  return (
    <Box>
      <Box sx={PANE_TITLE_SX}>{title}</Box>
      <Box sx={GRID_SX} data-testid={`cargo-${testPrefix}-grid`} {...{ [DROP_SIDE_ATTR]: testPrefix }}>
        {rows.map((r) => (
          <Box
            key={r.key} data-testid={`cargo-${testPrefix}-row`} data-key={r.key} data-count={r.count} title={r.label}
            onClick={onMove !== undefined ? () => { if (drag?.consumeClick() !== true) onMove(r.all); } : undefined}
            onPointerDown={onMove !== undefined && drag !== undefined ? (e) => drag.start(e, testPrefix, r.key) : undefined}
            sx={{ ...TILE_SX, border: `1px solid ${TIER_EDGE[r.tier]}`, cursor: onMove !== undefined ? 'grab' : 'default', touchAction: 'none' }}
          >
            {r.label}
            {r.count > 1 && <Box component="span" sx={COUNT_SX}>{r.count}</Box>}
          </Box>
        ))}
        {qs.map((i) => (
          <Box
            key={`q${i}`} data-testid="cargo-unknown-tile"
            sx={{ ...TILE_SX, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed rgba(143,224,189,0.35)', color: '#7f958c', fontSize: 14 }}
          >
            {i === 0 ? <Box sx={SPIN_SX} data-testid="cargo-search-spinner" /> : '?'}
          </Box>
        ))}
        {rows.length === 0 && hidden === 0 && <Box sx={{ ...EMPTY_SX, gridColumn: '1 / -1' }}>Empty</Box>}
      </Box>
    </Box>
  );
}

/** Your hold's weight against its capacity. */
function WeightBar({ used, capacity }: { used: number; capacity: number }): JSX.Element {
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 100;
  return (
    <Box data-testid="cargo-weight" data-used={Math.round(used)} data-capacity={Math.round(capacity)} sx={{ mt: '3px' }}>
      <Box sx={{ fontSize: 9, color: '#9fb8ad' }}>Weight {Math.round(used)} / {Math.round(capacity)}</Box>
      <Box sx={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${pct}%`, backgroundColor: pct >= 100 ? '#ff8f6b' : '#8fe0bd' }} />
      </Box>
    </Box>
  );
}

/** Slice 14c's switches on your own storage: does your ship drop its cargo
 *  here on its own, and does this storage take such drops? */
function AutoUnload({ entityId, ship, storage }: { entityId: number; ship?: boolean; storage?: boolean }): JSX.Element {
  const sw = (id: string, label: string, on: boolean, flip: () => void): JSX.Element => (
    <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      <Box sx={{ ...BTN_SX, minWidth: 22, textAlign: 'center' }} data-testid={id} data-on={on ? '1' : '0'} onClick={flip}>{on ? 'On' : 'Off'}</Box>
      <Box>{label}</Box>
    </Box>
  );
  return (
    <Box sx={{ mt: '3px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {ship !== undefined && sw('auto-unload-ship', 'My ship auto-unloads here', ship, () => sendSetAutoUnload('ship', !ship))}
      {storage !== undefined && sw('auto-unload-storage', 'Accept auto-unload', storage, () => sendSetAutoUnload('storage', !storage, entityId))}
    </Box>
  );
}

/** "12¢" (whole credits) or "1.5¢" (cheap goods). */
function credits(n: number): string {
  return n >= 10 ? `${Math.round(n)}¢` : `${Math.round(n * 10) / 10}¢`;
}

function Pane({ title, rows, verb, testPrefix, onMove, prices }: {
  title: string;
  rows: CargoRow[];
  verb: 'Take' | 'Put' | 'Buy' | 'Sell';
  testPrefix: 'here' | 'aboard';
  /** Absent = view only (a peek: cargo-pods slice 13). */
  onMove?: (items: CargoItems) => void;
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
            {onMove !== undefined && tradable(r) && r.count > 1 && (
              <Box sx={BTN_SX} data-testid={`cargo-${v}-one`} onClick={() => onMove(r.one)}>{verb} 1{priceOf(r, 1)}</Box>
            )}
            {onMove !== undefined && tradable(r) && (
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

/** C3 — the panel's target: `entityId` (a structure / NPC ship) or `ship`. */
export interface CargoPanelProps { entityId?: number; ship?: string }

export const CargoPanel = memo(function CargoPanel({ entityId, ship }: CargoPanelProps): JSX.Element {
  const target: CargoTarget = ship !== undefined ? { ship } : { entityId: entityId ?? -1 };
  const state = useUIStore((s) => {
    const c = s.cargoState;
    if (c === null) return null;
    return (ship !== undefined ? c.targetShip === ship : c.entityId === entityId) ? c : null;
  });

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
    sendCargoQuery(target);
    const t = setInterval(() => sendCargoQuery(target), CARGO_POLL_MS);
    return () => clearInterval(t);
  }, [entityId, ship]);

  // Slice 17: while stacks are hidden, ask again the moment the next one is
  // due (the search runs in game time; the 1 s poll alone would lag it).
  const timeScale = useUIStore((s) => s.timeScale);
  const revealIn = state?.hidden !== undefined ? state.revealInMs : undefined;
  useEffect(() => {
    if (revealIn === undefined) return;
    const t = setTimeout(() => sendCargoQuery(target), Math.max(50, revealIn / Math.max(0.25, timeScale) + 30));
    return () => clearTimeout(t);
  }, [state, revealIn, timeScale]);

  const here = cargoRows(state?.hold ?? null);
  const aboard = cargoRows(state?.ship ?? null);
  // Slice 18: a tile dropped on the other grid moves its whole stack.
  const drag = useTileDrag((from, key) => {
    const row = (from === 'here' ? here : aboard).find((r) => r.key === key);
    if (row !== undefined) sendCargoMove(target, from === 'here' ? 'take' : 'put', row.all);
  });
  const market = state?.market;
  // Slice 13: a peek (living stranger's cargo) is open to look, never to move.
  const peek = state?.open === true && state.takeable === false;
  const locked = state !== null && (!state.open || peek);

  return (
    <Box sx={ROOT_SX} data-testid="cargo-panel" data-open={state?.open === true && !peek ? '1' : '0'} data-peek={peek ? '1' : '0'} data-market={market ? '1' : '0'}>
      <Box sx={TITLE_SX}>
        {/* A pod has no capacity (0): show only the weight inside, never "/0". */}
        {market ? 'Market' : 'Cargo'}{state?.open === true && !market ? ` · ${Math.round(state.used)}${state.capacity > 0 ? `/${state.capacity}` : ''}` : ''}
      </Box>
      {state === null && <Box>Opening…</Box>}
      {state !== null && locked && <Box sx={WARN_SX} data-testid="cargo-locked">{state.message ?? 'Locked.'}</Box>}
      {state !== null && locked && state.breakIn !== undefined && (
        // C2 — breaking in is a hostile act: the owner's turrets will engage you.
        state.breakIn.pct === null ? (
          <Box sx={{ display: 'flex', gap: '3px', alignItems: 'center', mt: '3px' }}>
            <Box sx={BTN_SX} data-testid="cargo-break-in" onClick={() => sendBreakIn(target)}>
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
      {peek && <Grid title="Theirs (look only)" rows={here} hidden={state.hidden ?? 0} testPrefix="here" />}
      {state?.open === true && !peek && !market && (
        <>
          <Grid title="Theirs" rows={here} hidden={state.hidden ?? 0} testPrefix="here" onMove={(items) => sendCargoMove(target, 'take', items)} drag={drag} />
          {here.length > 0 && (
            <Box sx={{ ...BTN_SX, display: 'inline-block', mt: '3px' }} data-testid="cargo-take-found" onClick={() => sendCargoMove(target, 'take', allOf(here))}>
              {state.hidden !== undefined ? 'Take all found' : 'Take all'}
            </Box>
          )}
          <Grid title="Yours" rows={aboard} hidden={0} testPrefix="aboard" onMove={(items) => sendCargoMove(target, 'put', items)} drag={drag} />
          <WeightBar used={state.ship !== null ? holdWeight(state.ship) : 0} capacity={state.shipCapacity} />
          {entityId !== undefined && (state.autoUnload !== undefined || state.acceptAutoUnload !== undefined) && (
            <AutoUnload entityId={entityId} ship={state.autoUnload} storage={state.acceptAutoUnload} />
          )}
        </>
      )}
      {state?.open === true && !peek && market && (
        <>
          <Pane
            title={market ? 'For sale' : 'Here'} rows={here} verb={market ? 'Buy' : 'Take'} testPrefix="here"
            onMove={(items) => sendCargoMove(target, 'take', items)} prices={market?.buy}
          />
          <Pane
            title={`Aboard · ${Math.round(state.shipCapacity)} capacity`} rows={aboard} verb={market ? 'Sell' : 'Put'} testPrefix="aboard"
            onMove={(items) => sendCargoMove(target, 'put', items)} prices={market?.sell}
          />
        </>
      )}
      {state?.open === true && state.hidden !== undefined && (
        <Box sx={EMPTY_SX} data-testid="cargo-hidden" data-hidden={state.hidden}>Searching… {state.hidden} more</Box>
      )}
      {state?.open === true && state.orders !== undefined && entityId !== undefined && <FreightOrders entityId={entityId} orders={state.orders} />}
      {notice !== null && (
        <Box sx={notice.ok ? undefined : WARN_SX} data-testid="cargo-notice" data-ok={notice.ok ? '1' : '0'}>{notice.message}</Box>
      )}
    </Box>
  );
});

const TOGGLE_ROW_SX = { display: 'flex', gap: '4px', alignItems: 'center', pointerEvents: 'auto' as const, mt: 0.5 };
const TOGGLE_BTN_SX = { color: '#8fe0bd', p: 0.5 };
const TOGGLE_ICON_SX = { fontSize: { xs: 16, sm: 22 } };

/** Cargo pods 16 — a selected pod's Open button: live within the open reach
 *  (`withinLootOpenReach`), greyed with a hint beyond it. The window it opens
 *  shuts again when the ship leaves the reach. */
export const PodOpen = memo(function PodOpen({ entityId, inReach }: { entityId: number; inReach: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = open && inReach;
  return (
    <Box>
      <Box sx={TOGGLE_ROW_SX}>
        <Box
          component="button" data-testid="pod-open" data-in-reach={inReach ? '1' : '0'} disabled={!inReach}
          onClick={() => setOpen((v) => !v)}
          sx={{ ...BTN_SX, py: '2px', px: 1, fontWeight: 700, letterSpacing: 1, opacity: inReach ? 1 : 0.45, cursor: inReach ? 'pointer' : 'default' }}
        >
          {shown ? 'CLOSE' : 'OPEN'}
        </Box>
        {!inReach && <Box sx={{ fontSize: 9, color: '#9fb8ad' }}>Fly closer to open</Box>}
      </Box>
      {shown && <CargoPanel entityId={entityId} />}
    </Box>
  );
});

/** The inspector's "Cargo" toggle for a storage structure: opens the panel
 *  (which asks the server, so a locked or far structure says why). */
export const CargoAction = memo(function CargoAction({ entityId, ship }: CargoPanelProps): JSX.Element {
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
      {open && <CargoPanel {...(ship !== undefined ? { ship } : { entityId })} />}
    </Box>
  );
});
