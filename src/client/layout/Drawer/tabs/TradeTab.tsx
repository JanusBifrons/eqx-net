/**
 * Living World P2b — the Trade pages. Plan peppy-jumping-pinwheel; laid out as
 * a drill-down by `panels/TradePanel.tsx` (UI language U2-6a).
 *
 *   header   credits, standing with traders / robots / drones, which base to
 *            trade from (on the Trade panel's top list)
 *   Offers   the rotating board at your prices → Deal dialog (one-off or every
 *            10/30/60 min, number of visits, price band)
 *   Deals    your deals (state, next visit, cancel)
 *   History  what happened, newest first
 *   Gift     send goods or credits to a side for standing
 *
 * Truth = `GET /trade/economy` + `/trade/offers` (#16), polled by `useTradeData`
 * only while the Trade panel is on screen (drawer-perf rule) and refetched at
 * once on every `trade_notice`. The base picker reads the render mirror at that
 * same low cadence (`getGameClient()`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Select, TextField, Typography,
} from '@mui/material';
import { useUIStore } from '../../../state/store';
import { getGameClient } from '../../../net/clientSingleton';
import { loadStoredPlayerId } from '../../../identity/token';
import { loadToken } from '../../../auth/tokenStorage';
import { fetchEconomy, fetchOffers, saveTradeLastSeen } from '../../../net/tradeApi';
import { formatPrice, formatStanding, goodName, itemName, ownStorages, repFill, repLabel, sectorName, type OwnStorage } from '../../../net/tradeView';
import { sendAcceptOffer, sendCancelDeal, sendGift } from '../../../net/tradeClient';
import {
  ECON_ALLEGIANCES,
  MAX_OFFER_QTY,
  type EconAllegiance,
  type PlayerEconomyView,
  type TradeOffer,
} from '../../../../shared-types/economy';
import { GOOD_IDS, type GoodId } from '../../../../shared-types/goods';

const POLL_MS = 5000;

const MUTED_SX = { fontSize: 11, color: '#9aa0b4' } as const;
const REP_ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75 } as const;
const REP_NAME_SX = { width: 52, fontSize: 10, color: '#c8cde0', textTransform: 'capitalize' } as const;
const REP_TRACK_SX = { flex: 1, height: 5, borderRadius: '2px', bgcolor: 'rgba(255,255,255,0.08)', position: 'relative', overflow: 'hidden' } as const;
const REP_MID_SX = { position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', bgcolor: 'rgba(255,255,255,0.3)' } as const;
const REP_VALUE_SX = { width: 72, fontSize: 10, color: '#9aa0b4', textAlign: 'right' } as const;
const SELECT_SX = { fontSize: 11, height: 26, color: '#dde', '& .MuiSelect-icon': { color: '#9aa0b4' } } as const;
const ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, py: '3px', borderBottom: '1px solid rgba(255,255,255,0.06)' } as const;
const ROW_MAIN_SX = { flex: 1, minWidth: 0 } as const;
const SMALL_BTN_SX = { fontSize: 10, minWidth: 0, px: 1, py: 0 } as const;
const PAPER_PROPS = { sx: { bgcolor: '#0d1117', color: '#dde', border: '1px solid rgba(0,255,136,0.25)' } } as const;
const FIELD_SX = { '& input': { fontSize: 12, color: '#dde', py: '4px' }, '& label': { fontSize: 11, color: '#9aa0b4' } } as const;
const STATE_COLOR: Record<string, string> = {
  scheduled: '#9aa0b4', inbound: '#7fd6a8', docked: '#ffd479', departing: '#ffd479',
  settled: '#5fd6a0', failed: '#ff8a8a', cancelled: '#777',
};
const ACTIVE_DEAL_STATES: readonly string[] = ['scheduled', 'inbound', 'docked', 'departing'];

function repColor(rep: number): string {
  return rep >= 15 ? '#5fd6a0' : rep > -15 ? '#c8cde0' : '#ff8a8a';
}

/** The Trade panel's data: the economy view, the offer board and your bases. */
export interface TradeData {
  signedIn: boolean;
  wallet: number;
  view: PlayerEconomyView | null;
  offers: TradeOffer[];
  storages: OwnStorage[];
  baseId: number | null;
  setBaseId: (id: number) => void;
}

/** Deals still running (the Deals row's count); null before the first reply. */
export function activeDealCount(view: PlayerEconomyView | null): number | null {
  return view === null ? null : view.deals.filter((d) => ACTIVE_DEAL_STATES.includes(d.state)).length;
}

/** Polls the trade endpoints while `visible`; refetches on every trade notice. */
export function useTradeData(visible: boolean): TradeData {
  const noticeSeq = useUIStore((s) => s.tradeNoticeSeq);
  // Economy v2 W1 — buys and gifts are paid from the wallet (credits are virtual).
  const wallet = useUIStore((s) => s.wallet) ?? 0;
  const [view, setView] = useState<PlayerEconomyView | null>(null);
  const [offers, setOffers] = useState<TradeOffer[]>([]);
  const [storages, setStorages] = useState<OwnStorage[]>([]);
  const [baseId, setBaseId] = useState<number | null>(null);
  const playerId = loadStoredPlayerId();
  const signedIn = playerId !== null && loadToken() !== null;

  const refresh = useCallback(async () => {
    if (!playerId) return;
    // T3 — prices are regional: quote for the sector the player is in.
    const sector = useUIStore.getState().currentSectorKey;
    const [v, o] = await Promise.all([fetchEconomy(playerId), fetchOffers(playerId, sector)]);
    if (v) setView(v);
    if (o) setOffers(o);
    const m = getGameClient()?.mirror;
    if (m?.structures && m.swarm) {
      const swarm = m.swarm;
      setStorages(ownStorages(m.structures, (id) => swarm.get(id)?.shipKind, m.localPlayerId));
    }
  }, [playerId]);

  // Poll only while on screen; refetch at once on any trade notice.
  useEffect(() => {
    if (!visible || !signedIn) return;
    useUIStore.getState().clearTradeUnread();
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, signedIn, refresh, noticeSeq]);

  useEffect(() => {
    if (baseId === null && storages.length > 0) setBaseId(storages[0]!.entityId);
    if (baseId !== null && storages.length > 0 && !storages.some((s) => s.entityId === baseId)) setBaseId(storages[0]!.entityId);
  }, [storages, baseId]);

  return { signedIn, wallet, view, offers, storages, baseId, setBaseId };
}

export function TradeSignIn(): JSX.Element {
  return <Typography sx={MUTED_SX} data-testid="trade-signin">Sign in to trade, build reputation and post deals.</Typography>;
}

/** Credits, standing per side, and the base you trade from. */
export function TradeHeader({ data }: { data: TradeData }): JSX.Element {
  const { wallet, view, storages, baseId, setBaseId } = data;
  return (
    <>
      <Typography sx={{ fontSize: 11, color: '#ffd060', mb: 0.5 }} data-testid="trade-wallet" data-wallet={wallet}>
        Credits: ¢ {wallet.toLocaleString('en-US')}
      </Typography>
      <Box data-testid="trade-rep">
        {ECON_ALLEGIANCES.map((a) => {
          const rep = view?.rep[a] ?? 0;
          return (
            <Box key={a} sx={REP_ROW_SX} data-testid={`trade-rep-${a}`} data-rep={rep}>
              <Typography sx={REP_NAME_SX}>{a}</Typography>
              <Box sx={REP_TRACK_SX}>
                <Box sx={REP_MID_SX} />
                <Box sx={{ height: '100%', width: `${repFill(rep) * 100}%`, bgcolor: repColor(rep) }} />
              </Box>
              <Typography sx={REP_VALUE_SX}>{repLabel(rep)} {formatStanding(rep)}</Typography>
            </Box>
          );
        })}
      </Box>
      <Box sx={REP_ROW_SX}>
        <Typography sx={MUTED_SX}>Trade from</Typography>
        {storages.length === 0 ? (
          <Typography sx={MUTED_SX} data-testid="trade-no-storage">— build a Capital or Cargo Bay in this sector</Typography>
        ) : (
          <Select
            size="small"
            value={baseId ?? ''}
            onChange={(e) => setBaseId(Number(e.target.value))}
            sx={SELECT_SX}
            data-testid="trade-base-picker"
          >
            {storages.map((s) => (
              <MenuItem key={s.entityId} value={s.entityId} sx={{ fontSize: 11 }}>{s.label}</MenuItem>
            ))}
          </Select>
        )}
      </Box>
    </>
  );
}

/** Offers: the board at your prices; Deal opens the deal dialog. */
export function TradeOffersPage({ offers, baseId }: Pick<TradeData, 'offers' | 'baseId'>): JSX.Element {
  const [dealOffer, setDealOffer] = useState<TradeOffer | null>(null);
  return (
    <Box data-testid="trade-offers">
      {offers.length === 0 && <Typography sx={MUTED_SX}>No offers right now.</Typography>}
      {offers.map((o) => (
        <Box key={o.offerId} sx={ROW_SX} data-testid="trade-offer" data-offer-kind={o.kind} data-offer-good={o.good ?? undefined} data-offer-product={o.product}>
          <Box sx={ROW_MAIN_SX}>
            <Typography sx={{ fontSize: 11 }}>
              {o.kind === 'sell' ? 'Sell' : 'Buy'} {itemName(o)}
            </Typography>
            <Typography sx={MUTED_SX}>{formatPrice(o.unitPrice)} cr each · up to {o.maxQty}</Typography>
          </Box>
          <Button
            size="small"
            sx={SMALL_BTN_SX}
            disabled={baseId === null}
            onClick={() => setDealOffer(o)}
            data-testid="trade-offer-deal"
          >
            Deal
          </Button>
        </Box>
      ))}
      {dealOffer !== null && baseId !== null && (
        <DealDialog offer={dealOffer} baseId={baseId} onClose={() => setDealOffer(null)} />
      )}
    </Box>
  );
}

/** Deals: your deals with state, next visit and Cancel. */
export function TradeDealsPage({ view }: Pick<TradeData, 'view'>): JSX.Element {
  return (
    <Box data-testid="trade-deals">
      {(view?.deals.length ?? 0) === 0 && <Typography sx={MUTED_SX}>No deals yet. Pick an offer to start one.</Typography>}
      {view?.deals.map((d) => {
        const active = ACTIVE_DEAL_STATES.includes(d.state);
        return (
          <Box key={d.dealId} sx={ROW_SX} data-testid="trade-deal" data-deal-state={d.state}>
            <Box sx={ROW_MAIN_SX}>
              <Typography sx={{ fontSize: 11 }}>
                {d.kind === 'gift' ? `Gift to ${d.allegiance}` : `${d.kind === 'sell' ? 'Sell' : 'Buy'} ${d.qty} ${itemName(d)}`}
                {d.recurrenceMin ? ` · every ${d.recurrenceMin} min` : ''}
              </Typography>
              <Typography sx={{ ...MUTED_SX, color: STATE_COLOR[d.state] ?? '#9aa0b4' }}>
                {d.state}
                {d.state === 'scheduled' && d.nextVisitAtMs ? ` · next visit ${new Date(d.nextVisitAtMs).toLocaleTimeString()}` : ''}
                {d.visitsLeft !== null && d.recurrenceMin ? ` · ${d.visitsLeft} left` : ''}
                {` · ${sectorName(d.sectorKey)}`}
              </Typography>
            </Box>
            {active && (
              <Button size="small" sx={SMALL_BTN_SX} onClick={() => sendCancelDeal(d.dealId)} data-testid="trade-deal-cancel">
                Cancel
              </Button>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** History: what happened, newest first. Marks it seen while shown. */
export function TradeHistoryPage({ view, shown }: Pick<TradeData, 'view'> & { shown: boolean }): JSX.Element {
  useEffect(() => { if (shown) saveTradeLastSeen(Date.now()); }, [shown, view]);
  return (
    <Box data-testid="trade-history">
      {(view?.history.length ?? 0) === 0 && <Typography sx={MUTED_SX}>Nothing yet.</Typography>}
      {view?.history.map((h) => (
        <Box key={`${h.dealId}-${h.atMs}`} sx={ROW_SX} data-testid="trade-history-row" data-outcome={h.outcome}>
          <Typography sx={{ fontSize: 11, color: h.outcome === 'raided' ? '#ff8a8a' : '#dde', flex: 1 }}>{h.note}</Typography>
          <Typography sx={MUTED_SX}>{new Date(h.atMs).toLocaleTimeString()}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function DealDialog({ offer, baseId, onClose }: { offer: TradeOffer; baseId: number; onClose: () => void }): JSX.Element {
  const [qty, setQty] = useState(offer.product !== undefined ? 1 : Math.min(offer.maxQty, 20));
  const [every, setEvery] = useState<'once' | 10 | 30 | 60>('once');
  const [visits, setVisits] = useState(5);
  const [band, setBand] = useState(10);
  const total = useMemo(() => Math.round(qty * offer.unitPrice), [qty, offer.unitPrice]);
  const confirm = (): void => {
    sendAcceptOffer({
      offerId: offer.offerId,
      networkEntityId: baseId,
      qty: Math.max(1, Math.min(offer.maxQty, MAX_OFFER_QTY, Math.floor(qty))),
      recurrenceMin: every === 'once' ? null : every,
      visits: every === 'once' ? null : Math.max(1, Math.floor(visits)),
      priceBandPct: Math.max(0, Math.min(50, Math.floor(band))),
    });
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth PaperProps={PAPER_PROPS} data-testid="trade-deal-dialog">
      <DialogTitle sx={{ fontSize: 13, color: '#00ff88', pb: 0.5 }}>
        {offer.kind === 'sell' ? 'Sell' : 'Buy'} {itemName(offer)} @ {formatPrice(offer.unitPrice)} cr
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: '8px !important' }}>
        <TextField
          label={`Quantity (max ${offer.maxQty})`}
          type="number"
          size="small"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          sx={FIELD_SX}
          inputProps={{ min: 1, max: offer.maxQty, 'data-testid': 'trade-deal-qty' }}
        />
        {/* Economy v2 W4b — packed structures are one-off deals only. */}
        {offer.product === undefined && (
        <Select size="small" value={every} onChange={(e) => setEvery(e.target.value as typeof every)} sx={SELECT_SX} data-testid="trade-deal-every">
          <MenuItem value="once" sx={{ fontSize: 11 }}>One-off</MenuItem>
          <MenuItem value={10} sx={{ fontSize: 11 }}>Every 10 min</MenuItem>
          <MenuItem value={30} sx={{ fontSize: 11 }}>Every 30 min</MenuItem>
          <MenuItem value={60} sx={{ fontSize: 11 }}>Every 60 min</MenuItem>
        </Select>
        )}
        {every !== 'once' && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField label="Visits" type="number" size="small" value={visits} onChange={(e) => setVisits(Number(e.target.value))} sx={FIELD_SX} />
            <TextField label="Price band ±%" type="number" size="small" value={band} onChange={(e) => setBand(Number(e.target.value))} sx={FIELD_SX} />
          </Box>
        )}
        <Typography sx={MUTED_SX}>
          ≈ {total.toLocaleString('en-US')} cr {offer.kind === 'sell' ? 'paid to you' : 'from your wallet'} per visit, plus a 5 cr hauling fee.
          A hauler docks at your base; value changes hands when it leaves safely.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button size="small" sx={{ fontSize: 11 }} onClick={onClose}>Cancel</Button>
        <Button size="small" sx={{ fontSize: 11 }} variant="outlined" onClick={confirm} data-testid="trade-deal-confirm">
          Agree deal
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function GiftForm({ baseId }: { baseId: number | null }): JSX.Element {
  const [to, setTo] = useState<EconAllegiance>('traders');
  const [good, setGood] = useState<GoodId | 'credits'>('credits');
  const [amount, setAmount] = useState(100);
  const send = (): void => {
    if (baseId === null) return;
    const n = Math.max(1, Math.floor(amount));
    sendGift({
      allegiance: to,
      networkEntityId: baseId,
      good: good === 'credits' ? null : good,
      qty: good === 'credits' ? 0 : n,
      credits: good === 'credits' ? n : 0,
    });
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }} data-testid="trade-gift">
      <Typography sx={MUTED_SX}>A hauler collects the gift from your base. Standing gained shrinks if you give a lot at once.</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Typography sx={MUTED_SX}>To</Typography>
        <Select size="small" value={to} onChange={(e) => setTo(e.target.value as EconAllegiance)} sx={SELECT_SX} data-testid="trade-gift-to">
          {ECON_ALLEGIANCES.map((a) => <MenuItem key={a} value={a} sx={{ fontSize: 11, textTransform: 'capitalize' }}>{a}</MenuItem>)}
        </Select>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField label="Amount" type="number" size="small" value={amount} onChange={(e) => setAmount(Number(e.target.value))} sx={FIELD_SX} />
        <Select size="small" value={good} onChange={(e) => setGood(e.target.value as GoodId | 'credits')} sx={SELECT_SX} data-testid="trade-gift-good">
          <MenuItem value="credits" sx={{ fontSize: 11 }}>Credits</MenuItem>
          {GOOD_IDS.map((g) => <MenuItem key={g} value={g} sx={{ fontSize: 11 }}>{goodName(g)}</MenuItem>)}
        </Select>
      </Box>
      <Button size="small" variant="outlined" sx={{ fontSize: 11, alignSelf: 'flex-start' }} disabled={baseId === null} onClick={send} data-testid="trade-gift-send">
        Send gift
      </Button>
    </Box>
  );
}
