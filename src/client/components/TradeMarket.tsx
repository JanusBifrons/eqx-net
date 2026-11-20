/**
 * T4 — an NPC Freight Dock's trade window: the inside of the loot window
 * (LootWindow.tsx → GameWindow) when `cargo_state` carries a `market`.
 * One list of the DOCK's goods (stock, buy and sell price in fixed columns,
 * a buy and a sell icon), a basket under it, and a footer with the deal's
 * total, the hold after it and one confirm. Your own hold is never a pane: it
 * is read only to know what you can sell and how much room is free.
 *
 * The deal goes through the existing `cargo_move` path: the sells (`put`)
 * first, then the buys (`take`). The basket maths is pure (tradeBasket.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { Box, IconButton } from '@mui/material';
import AddShoppingCartIcon from '@mui/icons-material/AddShoppingCart';
import SellIcon from '@mui/icons-material/Sell';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import CloseIcon from '@mui/icons-material/Close';
import ShoppingCartCheckoutIcon from '@mui/icons-material/ShoppingCartCheckout';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { useUIStore } from '../state/store';
import { sendCargoMove, type CargoTarget } from '../net/tradeClient';
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../shared-types/goods';
import { productName } from '../../shared-types/blueprints';
import type { CargoState } from '../../shared-types/messages/cargoMessages';
import { holdWeight } from '../../core/cargo/hold';
import { CargoIcon } from './cargoIcons';
import { HUD } from '../hud/tokens';
import { WINDOW_BTN_BASE_SX, WINDOW_BTN_SECONDARY_SX, WINDOW_EDGE, WINDOW_FOOT_SX } from './GameWindow';
import { bump, checkTrade, credits, qtyIn, tradeMoves, type TradeDir, type TradeLine } from './tradeBasket';

const C = HUD.color;
const NUM = { fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
/** The same columns on every row and the header: icon, name, stock, buy, sell, two buttons. */
const COLS = '22px minmax(0,1fr) 46px 54px 54px 30px 30px';
const GRID_ROW_SX = { display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', columnGap: '6px' };
const BODY_SX = { display: 'flex', flexDirection: 'column' as const, gap: 1, px: 1.5, py: 1, flex: '1 1 auto', minHeight: 0 };
const HEAD_ROW_SX = {
  ...GRID_ROW_SX, flex: 'none', px: 0.75, fontSize: 10, fontWeight: 600, color: C.inkDim, letterSpacing: 1,
  textTransform: 'uppercase' as const,
};
/** The dock's list takes the room and scrolls inside its box. */
const LIST_SX = { display: 'flex', flexDirection: 'column' as const, gap: '2px', flex: '1 1 auto', minHeight: 0, overflowY: 'auto' as const };
const ROW_SX = { ...GRID_ROW_SX, px: 0.75, minHeight: 32, borderRadius: '5px', border: WINDOW_EDGE, backgroundColor: 'rgba(20,30,48,0.95)' };
const NAME_SX = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 12 };
const ICON_BTN_SX = { p: '3px', color: C.auto, '&.Mui-disabled': { color: 'rgba(160,200,255,0.22)' } };
const ICON_SX = { fontSize: 20 };
/** The basket: a short list under the dock's, capped so the dock list keeps its room. */
const BASKET_SX = {
  flex: '0 1 auto', minHeight: 0, maxHeight: '40%', overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const,
  gap: '2px', borderTop: WINDOW_EDGE, pt: 0.75,
};
const LINE_SX = {
  display: 'grid', gridTemplateColumns: '38px minmax(0,1fr) 26px 30px 26px 64px 26px', alignItems: 'center', columnGap: '4px',
  px: 0.75, minHeight: 28, borderRadius: '5px', backgroundColor: 'rgba(255,255,255,0.03)',
};
const SIDE_SX = { fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' as const };
const SMALL_BTN_SX = { p: '2px', color: C.inkDim };
const EMPTY_SX = { color: C.inkFaint, fontStyle: 'italic' as const, fontSize: 11, px: 0.75 };
const BTN_PRIMARY_SX = {
  ...WINDOW_BTN_BASE_SX, display: 'flex', alignItems: 'center', gap: '6px', borderColor: C.auto, color: '#04121a', backgroundColor: C.auto,
};

/** One thing the dock trades. */
interface DockItem {
  key: string;
  id: string;
  label: string;
  /** The dock's stock and what you carry. */
  stock: number;
  aboard: number;
  buy?: number | undefined;
  sell?: number | undefined;
}

/** The dock's own goods (those it buys or sells, catalogue order), then its packed items for sale. */
export function dockItems(market: NonNullable<CargoState['market']>, hold: Hold | null, ship: Hold | null): DockItem[] {
  const out: DockItem[] = [];
  for (const id of GOOD_IDS) {
    const buy = market.buy[id];
    const sell = market.sell[id];
    if (buy === undefined && sell === undefined) continue;
    out.push({
      key: `g:${id}`, id, label: GOOD_DEFS[id].displayName, stock: hold?.goods[id] ?? 0, aboard: ship?.goods[id] ?? 0, buy, sell,
    });
  }
  for (const [product, buy] of Object.entries(market.packed ?? {})) {
    out.push({
      key: `p:${product}`, id: product, label: `${productName(product)} (packed)`,
      stock: (hold?.packed ?? []).filter((p) => p.uid === undefined && p.product === product).length,
      aboard: 0, buy,
    });
  }
  return out;
}

const price = (n: number | undefined): string => (n === undefined ? '—' : credits(n));

export interface TradeMarketProps {
  target: CargoTarget;
  /** The reply (its identity marks a new one) and its market. */
  state: CargoState;
  market: NonNullable<CargoState['market']>;
  /** A move's verdict, held by the panel (the server's refusal shows here). */
  notice: { ok: boolean; message: string } | null;
  onClose?: (() => void) | undefined;
}

export function TradeMarket({ target, state, market, notice, onClose }: TradeMarketProps): JSX.Element {
  const [basket, setBasket] = useState<TradeLine[]>([]);
  // The sides sent and not yet answered, in order; each `ok` reply drops its side.
  const pending = useRef<('put' | 'take')[]>([]);
  useEffect(() => {
    if (state.ok === undefined || pending.current.length === 0) return;
    const dir = pending.current.shift()!;
    if (!state.ok) { pending.current = []; return; }
    const side: TradeDir = dir === 'put' ? 'sell' : 'buy';
    setBasket((b) => b.filter((l) => l.dir !== side));
  }, [state]);

  const wallet = useUIStore((s) => s.wallet);
  const items = dockItems(market, state.hold, state.ship);
  const byKey = new Map(items.map((it) => [it.key, it]));
  const shipUsed = state.ship !== null ? holdWeight(state.ship) : 0;
  const cap = state.shipCapacity;
  const check = checkTrade(basket, shipUsed, cap, wallet);
  const canBuy = (it: DockItem): boolean => it.buy !== undefined && qtyIn(basket, 'buy', it.key) < it.stock;
  const canSell = (it: DockItem): boolean => it.sell !== undefined && qtyIn(basket, 'sell', it.key) < it.aboard;
  const can = (dir: TradeDir, it: DockItem): boolean => (dir === 'buy' ? canBuy(it) : canSell(it));
  const add = (dir: TradeDir, it: DockItem, delta: number): void => {
    const unit = dir === 'buy' ? it.buy : it.sell;
    if (unit !== undefined) setBasket((b) => bump(b, dir, it.key, unit, delta));
  };
  const confirm = (): void => {
    const moves = tradeMoves(basket);
    pending.current = moves.map((m) => m.dir);
    for (const m of moves) sendCargoMove(target, m.dir, m.items);
  };
  const empty = basket.length === 0;
  const disabled = empty || check.why !== null;
  const ConfirmIcon = check.verb === 'Purchase' ? ShoppingCartCheckoutIcon : check.verb === 'Sell' ? SellIcon : TaskAltIcon;

  return (
    <>
      <Box sx={BODY_SX}>
        <Box sx={HEAD_ROW_SX}>
          <Box />
          <Box>Item</Box>
          <Box sx={NUM}>Stock</Box>
          <Box sx={NUM}>Buy</Box>
          <Box sx={NUM}>Sell</Box>
          <Box />
          <Box />
        </Box>
        <Box sx={LIST_SX} data-testid="cargo-here-list">
          {items.length === 0 && <Box sx={EMPTY_SX}>This dock trades nothing right now.</Box>}
          {items.map((it) => (
            <Box key={it.key} sx={ROW_SX} data-testid={`trade-row-${it.id}`} data-key={it.key} data-stock={it.stock} data-aboard={it.aboard}>
              <Box sx={{ width: 22, height: 22 }}><CargoIcon rowKey={it.key} /></Box>
              <Box sx={NAME_SX} title={it.label}>{it.label}</Box>
              <Box sx={{ ...NUM, fontSize: 12 }} data-testid="trade-stock">{it.stock}</Box>
              <Box sx={{ ...NUM, fontSize: 12, color: it.buy === undefined ? C.inkFaint : C.ink }} data-testid="trade-buy-price">{price(it.buy)}</Box>
              <Box sx={{ ...NUM, fontSize: 12, color: it.sell === undefined ? C.inkFaint : C.ink }} data-testid="trade-sell-price">{price(it.sell)}</Box>
              <IconButton size="small" sx={ICON_BTN_SX} aria-label={`Buy ${it.label}`} data-testid={`trade-buy-${it.id}`} disabled={!canBuy(it)} onClick={() => add('buy', it, 1)}>
                <AddShoppingCartIcon sx={ICON_SX} />
              </IconButton>
              <IconButton size="small" sx={ICON_BTN_SX} aria-label={`Sell ${it.label}`} data-testid={`trade-sell-${it.id}`} disabled={!canSell(it)} onClick={() => add('sell', it, 1)}>
                <SellIcon sx={ICON_SX} />
              </IconButton>
            </Box>
          ))}
        </Box>
        <Box sx={BASKET_SX} data-testid="trade-basket" data-lines={basket.length}>
          {empty && <Box sx={EMPTY_SX}>Basket empty: tap buy or sell on an item.</Box>}
          {basket.map((l) => {
            const it = byKey.get(l.key);
            const label = it?.label ?? l.key;
            return (
              <Box key={`${l.dir}:${l.key}`} sx={LINE_SX} data-testid={`trade-line-${l.dir}-${l.key.slice(2)}`} data-qty={l.qty}>
                <Box sx={{ ...SIDE_SX, color: l.dir === 'buy' ? C.auto : C.hullOk }}>{l.dir === 'buy' ? 'Buy' : 'Sell'}</Box>
                <Box sx={NAME_SX}>{label}</Box>
                <IconButton size="small" sx={SMALL_BTN_SX} aria-label="One less" data-testid="trade-qty-minus" onClick={() => it && add(l.dir, it, -1)}>
                  <RemoveIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <Box sx={{ ...NUM, textAlign: 'center' as const, fontSize: 12 }}>{l.qty}</Box>
                <IconButton
                  size="small" sx={SMALL_BTN_SX} aria-label="One more" data-testid="trade-qty-plus"
                  disabled={it === undefined || !can(l.dir, it)} onClick={() => it && add(l.dir, it, 1)}
                >
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <Box sx={{ ...NUM, fontSize: 12 }}>{l.dir === 'buy' ? '−' : '+'}{credits(l.unit * l.qty)}</Box>
                <IconButton size="small" sx={SMALL_BTN_SX} aria-label="Remove" data-testid="trade-line-remove" onClick={() => setBasket((b) => b.filter((x) => x !== l))}>
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box sx={WINDOW_FOOT_SX}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {!empty && (
            <Box sx={{ display: 'flex', gap: 1.5, color: C.ink, ...NUM, textAlign: 'left' as const }}>
              <Box data-testid="trade-net" data-net={Math.round(check.net * 10) / 10}>
                {check.net < 0 ? `Pay ${credits(-check.net)}` : `Get ${credits(check.net)}`}
              </Box>
              <Box data-testid="trade-hold-after" sx={{ color: check.holdAfter > cap ? C.danger : C.ink }}>
                Hold {Math.round(check.holdAfter * 10) / 10}/{Math.round(cap)}
              </Box>
            </Box>
          )}
          {!empty && check.why !== null && <Box sx={{ color: C.manual }} data-testid="trade-why">{check.why}</Box>}
          {notice !== null
            ? <Box sx={{ color: notice.ok ? C.ink : C.manual }} data-testid="cargo-notice" data-ok={notice.ok ? '1' : '0'}>{notice.message}</Box>
            : empty && <Box>Hold {Math.round(shipUsed * 10) / 10}/{Math.round(cap)}{wallet !== null ? ` · ${credits(wallet)}` : ''}</Box>}
        </Box>
        {onClose !== undefined && (
          <Box component="button" sx={WINDOW_BTN_SECONDARY_SX} onClick={onClose} data-testid="loot-window-close">Close</Box>
        )}
        <Box
          component="button" data-testid="trade-confirm" data-verb={check.verb} disabled={disabled} onClick={confirm}
          sx={{ ...BTN_PRIMARY_SX, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer' }}
        >
          <ConfirmIcon sx={{ fontSize: 18 }} />
          {check.verb}
        </Box>
      </Box>
    </>
  );
}
