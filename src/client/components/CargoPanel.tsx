/**
 * C1 (plan soft-leaping-truffle v3) — a structure's, ship's or pod's cargo:
 * the inside of the loot window (LootWindow.tsx). A header (name, chips,
 * close), two grids side by side ("theirs" and your hold), a footer (hint or
 * a move's verdict, Close, Take all). Every part keeps its size while stacks
 * reveal or move, so taps always land. Rebuilt ONLY from the server's
 * `cargo_state` replies (#16): it asks on mount and every second while it's
 * on screen. The server decides whether it opens (relation, range, a live
 * ship) and says why when it doesn't.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import { sendBreakIn, sendBreakInCancel, sendCargoMove, sendCargoQuery, sendSetAutoUnload, sendSetFreightOrders, type CargoTarget } from '../net/tradeClient';
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods';
import { holdWeight } from '../../core/cargo/hold';
import { allOf, cargoRows, rowHold, type CargoRow } from './cargoRows';
import { DROP_SIDE_ATTR, useTileDrag, type TileDrag } from './useTileDrag';
import { CargoIcon } from './cargoIcons';
import { HUD } from '../hud/tokens';
import { MAX_FREIGHT_ORDERS, type CargoItems, type CargoState, type FreightOrder } from '../../shared-types/messages/cargoMessages';

export const CARGO_POLL_MS = 1000;
/** How long a move's verdict stays on the panel. */
export const CARGO_NOTICE_MS = 3000;

const C = HUD.color;
const EDGE = `1px solid ${C.panelEdge}`;
const ROOT_SX = {
  pointerEvents: 'auto' as const, display: 'flex', flexDirection: 'column' as const, color: C.ink,
  fontFamily: HUD.font.label, fontSize: 12, flex: '1 1 auto', minHeight: 0,
};
const HEAD_SX = { flex: 'none', display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1, borderBottom: EDGE, minHeight: 52, flexWrap: 'wrap' as const };
const HEAD_TITLE_SX = { fontWeight: 700, fontSize: 15, letterSpacing: 0.5 };
const CHIP_SX = {
  fontSize: 10, px: '7px', py: '2px', borderRadius: '9px', border: '1px solid', fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase' as const, whiteSpace: 'nowrap' as const,
};
const X_SX = {
  ml: 'auto', width: 32, height: 32, border: EDGE, borderRadius: '6px', display: 'grid', placeItems: 'center',
  color: C.inkDim, fontSize: 16, cursor: 'pointer', background: 'transparent', p: 0,
};
const BODY_SX = {
  display: 'flex', flexDirection: { xs: 'column', sm: 'row' } as const, gap: { xs: 1.5, sm: 2 }, px: 1.5, py: 1.25,
  justifyContent: 'center', alignItems: { xs: 'center', sm: 'flex-start' } as const,
  // A short screen (a sideways phone) scrolls the grids, never the header or footer.
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto' as const,
};
const SIDE_HEAD_SX = {
  display: 'flex', alignItems: 'center', gap: '6px', mb: '6px', fontSize: 11, fontWeight: 600, color: C.inkDim,
  letterSpacing: 1, textTransform: 'uppercase' as const, minHeight: 16,
};
const NUM_SX = { ml: 'auto', fontFamily: HUD.font.num, fontSize: 11, color: C.ink, textTransform: 'none' as const, letterSpacing: 0 };
const FOOT_SX = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderTop: EDGE, minHeight: 58, fontSize: 11, color: C.inkDim,
};
const BTN_BASE = {
  height: 38, px: 2, borderRadius: '6px', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13,
  letterSpacing: 0.5, border: '1px solid', cursor: 'pointer', userSelect: 'none' as const, fontFamily: HUD.font.label,
  whiteSpace: 'nowrap' as const,
};
const BTN_PRIMARY_SX = { ...BTN_BASE, borderColor: C.auto, color: '#04121a', backgroundColor: C.auto };
const BTN_SECONDARY_SX = { ...BTN_BASE, borderColor: C.panelEdge, color: C.ink, backgroundColor: 'transparent' };
/** Small inline buttons (break in, switches, market rows). */
const BTN_SX = {
  px: 1, py: '2px', borderRadius: '4px', cursor: 'pointer', userSelect: 'none' as const, fontSize: 11,
  border: `1px solid ${C.auto}`, color: C.ink, backgroundColor: 'rgba(52,216,255,0.12)',
};
const BANNER_SX = {
  fontSize: 11, color: C.manual, border: '1px solid rgba(255,176,46,0.4)', backgroundColor: 'rgba(255,176,46,0.08)',
  px: 1, py: '5px', borderRadius: '5px', mt: 1, display: 'flex', flexDirection: 'column' as const, gap: '4px',
};
const LIST_SX = { display: 'flex', flexDirection: 'column' as const, gap: '2px', maxHeight: 110, overflowY: 'auto' as const };
const ROW_SX = {
  display: 'flex', alignItems: 'center', gap: '3px', px: 0.5, py: '1px', borderRadius: '3px',
  border: EDGE, backgroundColor: 'rgba(20,30,48,0.9)',
};
const LABEL_SX = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const };
const EMPTY_SX = { color: C.inkFaint, fontStyle: 'italic' as const };
const PANE_TITLE_SX = { ...SIDE_HEAD_SX, mb: 0.5 };

/** Tile edge and inner glow per rarity, the pod beacon's grey / blue / gold. */
const TIER_EDGE = ['rgba(160,200,255,0.28)', 'rgba(74,168,255,0.6)', 'rgba(255,200,58,0.7)'] as const;
const TIER_GLOW = ['none', 'inset 0 0 10px rgba(74,168,255,0.18)', 'inset 0 0 12px rgba(255,200,58,0.22)'] as const;
/** A grid always shows this many slots (three rows of six): it reserves its
 *  space, so the window never grows as stacks reveal or move. More scroll. */
export const GRID_COLS = 6;
export const GRID_SLOTS = GRID_COLS * 3;
/** Tile edge (px): a touch smaller on a phone so six fit across. */
const TILE = { xs: 50, sm: 58 } as const;
const GAP_PX = 5;
/** A sideways phone is wide (`sm`) but short: it takes the phone tile too. */
const SHORT = '@media (max-height: 480px)';
const gridWidth = (tile: number): number => tile * GRID_COLS + GAP_PX * (GRID_COLS - 1);
const GRID_SX = {
  display: 'grid', gap: `${GAP_PX}px`, alignContent: 'start', overflowY: 'auto' as const,
  gridTemplateColumns: { xs: `repeat(${GRID_COLS}, ${TILE.xs}px)`, sm: `repeat(${GRID_COLS}, ${TILE.sm}px)` },
  gridAutoRows: { xs: `${TILE.xs}px`, sm: `${TILE.sm}px` },
  height: { xs: TILE.xs * 3 + GAP_PX * 2, sm: TILE.sm * 3 + GAP_PX * 2 },
  [SHORT]: { gridTemplateColumns: `repeat(${GRID_COLS}, ${TILE.xs}px)`, gridAutoRows: `${TILE.xs}px`, height: TILE.xs * 3 + GAP_PX * 2 },
};
/** A side is exactly as wide as its grid, so its header and bar line up. */
const SIDE_SX = {
  display: 'flex', flexDirection: 'column' as const, flex: '0 0 auto',
  width: { xs: gridWidth(TILE.xs), sm: gridWidth(TILE.sm) },
  maxWidth: '100%',
  [SHORT]: { width: gridWidth(TILE.xs) },
};
const CELL_SX = {
  position: 'relative' as const, boxSizing: 'border-box' as const, borderRadius: '5px', overflow: 'hidden',
  border: '1px solid rgba(160,200,255,0.10)', backgroundColor: 'rgba(255,255,255,0.025)',
};
const ITEM_SX = { ...CELL_SX, backgroundColor: 'rgba(20,30,48,0.95)', userSelect: 'none' as const };
const ITEM_NAME_SX = {
  position: 'absolute' as const, left: 4, top: 2, right: 4, fontSize: 9, color: C.inkDim,
  whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3,
};
const ITEM_ICON_SX = { position: 'absolute' as const, left: '50%', top: '46%', transform: 'translate(-50%,-50%)', width: 26, height: 26 };
const ITEM_COUNT_SX = { position: 'absolute' as const, right: 4, bottom: 2, fontFamily: HUD.font.num, fontSize: 11, fontWeight: 600 };
const HIDDEN_SX = {
  ...CELL_SX, display: 'grid', placeItems: 'center', color: 'rgba(223,232,245,0.38)', fontWeight: 700, fontSize: 18,
  borderColor: 'rgba(180,190,205,0.25)',
  background: 'repeating-linear-gradient(135deg, rgba(150,160,175,0.20) 0 6px, rgba(150,160,175,0.13) 6px 12px)',
};
const SEARCHING_SX = { ...CELL_SX, display: 'grid', placeItems: 'center', borderColor: C.auto, backgroundColor: 'rgba(150,160,175,0.16)' };
const SPIN_SX = {
  width: '62%', height: '62%', animation: 'eqx-loot-spin 0.9s linear infinite',
  '@keyframes eqx-loot-spin': { to: { transform: 'rotate(360deg)' } },
};

function Chip({ label, color }: { label: string; color: string }): JSX.Element {
  return <Box component="span" sx={{ ...CHIP_SX, color, borderColor: color === C.inkDim ? C.panelEdge : color }}>{label}</Box>;
}

/** A thin bar: `pct` 0..100 in `color`. */
function Bar({ pct, color }: { pct: number; color: string }): JSX.Element {
  return (
    <Box sx={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', mb: '7px' }}>
      <Box sx={{ height: '100%', width: `${pct}%`, backgroundColor: color }} />
    </Box>
  );
}

/** Cargo pods slice 17: one grid of the loot window. A tile per stack, then a
 *  striped "?" tile per stack still being searched (the first spins), then
 *  empty slots. Tap a tile to move the whole stack, or (slice 18) drag it
 *  onto the other grid; no `onMove` = look only (a peek). */
function Grid({ rows, hidden, testPrefix, onMove, drag }: {
  rows: CargoRow[];
  hidden: number;
  testPrefix: 'here' | 'aboard';
  onMove?: (items: CargoItems) => void;
  drag?: TileDrag;
}): JSX.Element {
  const qs: number[] = [];
  for (let i = 0; i < hidden; i++) qs.push(i);
  const pad: number[] = [];
  for (let i = rows.length + hidden; i < GRID_SLOTS; i++) pad.push(i);
  return (
    <Box sx={GRID_SX} data-testid={`cargo-${testPrefix}-grid`} {...{ [DROP_SIDE_ATTR]: testPrefix }}>
      {rows.map((r) => (
        <Box
          key={r.key} data-testid={`cargo-${testPrefix}-row`} data-key={r.key} data-count={r.count} title={r.label}
          onClick={onMove !== undefined ? () => { if (drag?.consumeClick() !== true) onMove(r.all); } : undefined}
          onPointerDown={onMove !== undefined && drag !== undefined ? (e) => drag.start(e, testPrefix, r.key) : undefined}
          sx={{
            ...ITEM_SX, borderColor: TIER_EDGE[r.tier], boxShadow: TIER_GLOW[r.tier],
            cursor: onMove !== undefined ? 'grab' : 'default', touchAction: 'none',
          }}
        >
          <Box sx={ITEM_NAME_SX}>{r.label}</Box>
          <Box sx={ITEM_ICON_SX}><CargoIcon rowKey={r.key} /></Box>
          <Box component="span" sx={ITEM_COUNT_SX}>×{r.count}</Box>
        </Box>
      ))}
      {qs.map((i) => (i === 0 ? (
        <Box key={`q${i}`} data-testid="cargo-unknown-tile" sx={SEARCHING_SX}>
          <Box component="svg" viewBox="0 0 40 40" sx={SPIN_SX} data-testid="cargo-search-spinner">
            <circle cx="20" cy="20" r="16" stroke="rgba(52,216,255,0.2)" strokeWidth="4" fill="none" />
            <circle cx="20" cy="20" r="16" stroke={C.auto} strokeWidth="4" fill="none" strokeDasharray="100" strokeDashoffset="62" strokeLinecap="round" />
          </Box>
        </Box>
      ) : (
        <Box key={`q${i}`} data-testid="cargo-unknown-tile" sx={HIDDEN_SX}>?</Box>
      )))}
      {pad.map((i) => <Box key={`s${i}`} sx={CELL_SX} data-testid="cargo-empty-slot" />)}
    </Box>
  );
}

/** Slice 14c's switches on your own storage: does your ship drop its cargo
 *  here on its own, and does this storage take such drops? */
function AutoUnload({ entityId, ship, storage }: { entityId: number; ship?: boolean; storage?: boolean }): JSX.Element {
  const sw = (id: string, label: string, on: boolean, flip: () => void): JSX.Element => (
    <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: 11, color: C.inkDim }}>
      <Box sx={{ ...BTN_SX, minWidth: 26, textAlign: 'center' }} data-testid={id} data-on={on ? '1' : '0'} onClick={flip}>{on ? 'On' : 'Off'}</Box>
      <Box>{label}</Box>
    </Box>
  );
  return (
    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {ship !== undefined && sw('auto-unload-ship', 'My ship auto-unloads here', ship, () => sendSetAutoUnload('ship', !ship))}
      {storage !== undefined && sw('auto-unload-storage', 'Accept auto-unload', storage, () => sendSetAutoUnload('storage', !storage, entityId))}
    </Box>
  );
}

/** "12¢" (whole credits) or "1.5¢" (cheap goods). */
function credits(n: number): string {
  return n >= 10 ? `${Math.round(n)}¢` : `${Math.round(n * 10) / 10}¢`;
}

/** T4 — a market's list: rows with Buy / Sell buttons and their prices. */
function Pane({ title, rows, verb, testPrefix, onMove, prices }: {
  title: string;
  rows: CargoRow[];
  verb: 'Buy' | 'Sell';
  testPrefix: 'here' | 'aboard';
  onMove: (items: CargoItems) => void;
  prices: Partial<Record<string, number>>;
}): JSX.Element {
  const v = verb.toLowerCase();
  const priceOf = (r: CargoRow, qty: number): string => {
    const unit = prices[r.key.slice(2)];
    return unit === undefined ? '' : ` · ${credits(unit * qty)}`;
  };
  const tradable = (r: CargoRow): boolean => r.key.startsWith('g:') && prices[r.key.slice(2)] !== undefined;
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
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
  fontSize: 10, background: 'rgba(20,30,48,0.95)', color: C.ink, border: EDGE,
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
    <Box data-testid="freight-orders" sx={{ px: 1.5, pb: 1 }}>
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

/** C2 — breaking in is a hostile act: the owner's turrets will engage you. */
function BreakIn({ target, breakIn }: { target: CargoTarget; breakIn: NonNullable<CargoState['breakIn']> }): JSX.Element {
  if (breakIn.pct === null) {
    return (
      <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Box sx={BTN_SX} data-testid="cargo-break-in" onClick={() => sendBreakIn(target)}>
          Break in · {Math.round(breakIn.durationMs / 1000)}s
        </Box>
        <Box sx={{ color: C.inkDim }}>hostile: their turrets will fire</Box>
      </Box>
    );
  }
  const pct = Math.round(breakIn.pct * 100);
  return (
    <Box data-testid="cargo-break-in-progress" data-pct={pct}>
      <Box>Breaking in… {pct}%</Box>
      <Box sx={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', my: '3px' }}>
        <Box sx={{ height: '100%', width: `${pct}%`, backgroundColor: C.danger }} />
      </Box>
      <Box sx={{ ...BTN_SX, display: 'inline-block' }} data-testid="cargo-break-in-cancel" onClick={() => sendBreakInCancel()}>Stop</Box>
    </Box>
  );
}

/** C3 — the panel's target: `entityId` (a structure / NPC ship) or `ship`. */
export interface CargoPanelProps { entityId?: number; ship?: string }

export interface CargoWindowProps extends CargoPanelProps {
  /** The window's name ("Cargo pod", a structure's or ship's name). */
  title?: string;
  /** A neutral chip beside the name, e.g. the pod's size. */
  subtitle?: string;
  /** The left grid's heading ("Pod contents"); default "Contents". */
  theirsLabel?: string;
  /** Present = the header's ✕ and the footer's Close. */
  onClose?: () => void;
}

export const CargoPanel = memo(function CargoPanel({ entityId, ship, title, subtitle, theirsLabel, onClose }: CargoWindowProps): JSX.Element {
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
  // Slice 19: your own ship ("your hold" from the HUD cargo chip): one grid,
  // all visible; a tap selects a stack to inspect.
  const own = state?.open === true && state.own === true;
  const peek = state?.open === true && state.takeable === false && !own;
  const locked = state !== null && !state.open;
  const loot = state?.open === true && !peek && !own && market === undefined;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = own ? (here.find((r) => r.key === picked) ?? null) : null;
  const hidden = state?.open === true ? state.hidden : undefined;

  const statusChip = state === null ? null
    : own ? <Chip label="Own" color={C.hullOk} />
      : peek ? <Chip label="Living · look only" color={C.danger} />
      : locked ? <Chip label="Locked" color={C.manual} />
        : market !== undefined ? <Chip label="Market" color={C.auto} />
          : state.autoUnload !== undefined || state.acceptAutoUnload !== undefined ? <Chip label="Yours" color={C.hullOk} />
            : null;

  const theirsWeight = state?.open === true
    ? (hidden !== undefined ? '?' : `${Math.round(state.used)}`) + (state.capacity > 0 ? ` / ${Math.round(state.capacity)}` : '')
    : '';
  const shipUsed = state?.ship ? holdWeight(state.ship) : 0;
  const shipCap = state?.shipCapacity ?? 0;
  const ownPct = own && state.capacity > 0 ? Math.min(100, Math.round((state.used / state.capacity) * 100)) : 0;
  const shipPct = shipCap > 0 ? Math.min(100, Math.round((shipUsed / shipCap) * 100)) : 100;
  const hint = peek ? 'Look only while you stay in range. Destroy it and its pod keeps a coin flip of each stack.'
    : own ? 'Everything visible — no search on your own or allied ships'
      : loot ? (hidden !== undefined ? 'Drag or tap an item to move it · items appear as you search' : 'Drag or tap an item to move it')
      : market !== undefined ? 'Buy and sell at the listed prices'
        : '';

  return (
    <Box sx={ROOT_SX} data-testid="cargo-panel" data-open={state?.open === true && !peek ? '1' : '0'} data-peek={peek ? '1' : '0'} data-market={market ? '1' : '0'}>
      <Box sx={HEAD_SX}>
        <Box sx={HEAD_TITLE_SX}>{title ?? (market ? 'Market' : 'Cargo')}</Box>
        {subtitle !== undefined && subtitle !== '' && <Chip label={subtitle} color={C.inkDim} />}
        {statusChip}
        {onClose !== undefined && (
          <Box component="button" sx={X_SX} onClick={onClose} aria-label="Close" data-testid="loot-window-x">✕</Box>
        )}
      </Box>

      {state === null && <Box sx={{ ...BODY_SX, color: C.inkDim }}>Opening…</Box>}
      {locked && (
        <Box sx={{ px: 1.5, py: 1.25 }}>
          <Box sx={BANNER_SX}>
            <Box data-testid="cargo-locked">{state.message ?? 'Locked.'}</Box>
            {state.breakIn !== undefined && <BreakIn target={target} breakIn={state.breakIn} />}
          </Box>
        </Box>
      )}

      {(loot || peek) && (
        <Box sx={BODY_SX}>
          <Box sx={SIDE_SX}>
            <Box sx={SIDE_HEAD_SX}>
              {peek ? 'Their hold' : (theirsLabel ?? 'Contents')}
              {hidden !== undefined && (
                <Box component="span" sx={{ color: C.auto, textTransform: 'none', letterSpacing: 0 }} data-testid="cargo-hidden" data-hidden={hidden}>
                  ● {peek ? 'scanning' : 'searching'} {here.length} / {here.length + hidden}
                </Box>
              )}
              <Box component="span" sx={NUM_SX} data-testid="cargo-here-weight">{theirsWeight}</Box>
            </Box>
            <Bar pct={state.capacity > 0 && hidden === undefined ? Math.min(100, (state.used / state.capacity) * 100) : 0} color="rgba(160,200,255,0.5)" />
            <Grid
              rows={here} hidden={hidden ?? 0} testPrefix="here" drag={drag}
              {...(peek ? {} : { onMove: (items: CargoItems) => sendCargoMove(target, 'take', items) })}
            />
            {peek && (
              <Box sx={BANNER_SX}>
                <Box data-testid="cargo-locked">{state.message ?? 'View only.'}</Box>
                {state.breakIn !== undefined && <BreakIn target={target} breakIn={state.breakIn} />}
              </Box>
            )}
          </Box>
          {(loot || state.ship !== null) && (
            <Box sx={{ ...SIDE_SX, opacity: peek ? 0.55 : 1 }}>
              <Box sx={SIDE_HEAD_SX}>
                Your hold
                <Box component="span" sx={NUM_SX} data-testid="cargo-weight" data-used={Math.round(shipUsed)} data-capacity={Math.round(shipCap)}>
                  {Math.round(shipUsed * 10) / 10} / {Math.round(shipCap)}
                </Box>
              </Box>
              <Bar pct={shipPct} color={shipPct >= 100 ? C.danger : shipPct >= 90 ? C.manual : C.hullOk} />
              <Grid
                rows={aboard} hidden={0} testPrefix="aboard" drag={drag}
                {...(peek ? {} : { onMove: (items: CargoItems) => sendCargoMove(target, 'put', items) })}
              />
              {entityId !== undefined && (state.autoUnload !== undefined || state.acceptAutoUnload !== undefined) && (
                <AutoUnload entityId={entityId} ship={state.autoUnload} storage={state.acceptAutoUnload} />
              )}
            </Box>
          )}
        </Box>
      )}

      {own && (
        <Box sx={BODY_SX}>
          <Box sx={SIDE_SX}>
            <Box sx={SIDE_HEAD_SX}>
              Hold
              <Box component="span" sx={NUM_SX} data-testid="cargo-here-weight">{theirsWeight}</Box>
            </Box>
            <Bar pct={ownPct} color={ownPct >= 100 ? C.danger : ownPct >= 90 ? C.manual : C.hullOk} />
            <Grid rows={here} hidden={0} testPrefix="here" onMove={(items) => setPicked(here.find((r) => r.all === items)?.key ?? null)} />
          </Box>
          <Box sx={SIDE_SX} data-testid="cargo-selected">
            <Box sx={SIDE_HEAD_SX}>Selected</Box>
            {selected !== null ? (
              <Box sx={{ display: 'flex', gap: '10px', alignItems: 'center', py: 1 }} data-key={selected.key}>
                <Box sx={{ width: 44, height: 44, flex: 'none' }}><CargoIcon rowKey={selected.key} /></Box>
                <Box>
                  <Box sx={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{selected.label} ×{selected.count}</Box>
                  <Box sx={{ ...NUM_SX, fontSize: 11, color: C.inkDim }}>{Math.round(holdWeight(rowHold(state.hold!, selected)) * 10) / 10} weight</Box>
                </Box>
              </Box>
            ) : (
              <Box sx={{ fontSize: 11, color: C.inkDim, py: 1 }}>Tap an item to inspect it.</Box>
            )}
            {state.autoUnload !== undefined && (
              <Box sx={{ mt: 1, display: 'flex', gap: '6px', alignItems: 'center', fontSize: 11, color: C.inkDim }}>
                <Box sx={{ ...BTN_SX, minWidth: 26, textAlign: 'center' }} data-testid="auto-unload-ship" data-on={state.autoUnload ? '1' : '0'} onClick={() => sendSetAutoUnload('ship', !state.autoUnload)}>{state.autoUnload ? 'On' : 'Off'}</Box>
                <Box>Auto-unload at my storage</Box>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {state?.open === true && !peek && !own && market !== undefined && (
        <Box sx={{ ...BODY_SX, flexDirection: 'row' }}>
          <Pane title="For sale" rows={here} verb="Buy" testPrefix="here" onMove={(items) => sendCargoMove(target, 'take', items)} prices={market.buy} />
          <Pane
            title={`Aboard · ${Math.round(state.shipCapacity)} capacity`} rows={aboard} verb="Sell" testPrefix="aboard"
            onMove={(items) => sendCargoMove(target, 'put', items)} prices={market.sell}
          />
        </Box>
      )}
      {state?.open === true && state.orders !== undefined && entityId !== undefined && <FreightOrders entityId={entityId} orders={state.orders} />}

      {/* One footer of fixed height: a move's verdict, else the hint; then the actions. */}
      <Box sx={FOOT_SX}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {notice !== null
            ? <Box sx={{ color: notice.ok ? C.ink : C.manual }} data-testid="cargo-notice" data-ok={notice.ok ? '1' : '0'}>{notice.message}</Box>
            : hint}
        </Box>
        {onClose !== undefined && (
          <Box component="button" sx={BTN_SECONDARY_SX} onClick={onClose} data-testid="loot-window-close">Close</Box>
        )}
        {loot && (
          <Box
            component="button" data-testid="cargo-take-found" disabled={here.length === 0}
            onClick={() => sendCargoMove(target, 'take', allOf(here))}
            sx={{ ...BTN_PRIMARY_SX, opacity: here.length === 0 ? 0.35 : 1, cursor: here.length === 0 ? 'default' : 'pointer' }}
          >
            {hidden !== undefined ? 'Take all found' : 'Take all'}
          </Box>
        )}
        {peek && <Box component="button" disabled sx={{ ...BTN_PRIMARY_SX, opacity: 0.35, cursor: 'default' }}>Take</Box>}
      </Box>
    </Box>
  );
});
