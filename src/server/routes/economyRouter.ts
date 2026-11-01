/**
 * Economy read endpoints (plan peppy-jumping-pinwheel P2) — the Trade tab's
 * data. Off the 60 Hz tick (polled every few seconds while the tab is open).
 *
 *   GET /trade/offers?playerId=    the offers board at the player's prices
 *   GET /trade/economy?playerId=   standing, deals, history, econVersion (#16:
 *                                  the client rebuilds its whole Trade view
 *                                  from this; `trade_notice` only accelerates)
 *
 * `playerId` is bounded to 64 chars (S5). Reads only — every state change goes
 * through the session-authenticated room messages.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import type { PlayerEconomyView, TradeOffer } from '../../shared-types/economy.js';

export interface EconomyRouteProvider {
  offersFor(playerId: string, sectorKey?: string | null): TradeOffer[];
  view(playerId: string): PlayerEconomyView;
}

let _provider: EconomyRouteProvider | null = null;

export function setEconomyRouteProvider(p: EconomyRouteProvider | null): void {
  _provider = p;
}

function playerIdOf(req: Request): string | null {
  const raw = req.query.playerId;
  const id = typeof raw === 'string' ? raw : '';
  return id.length >= 1 && id.length <= 64 ? id : null;
}

// Explicit type (TS2742 under declaration emit, like galaxyRouter).
export const economyRouter: ExpressRouter = Router();

economyRouter.get('/offers', (req: Request, res: Response) => {
  const pid = playerIdOf(req);
  // T3 — prices are regional: the client says which sector it trades from.
  const sector = typeof req.query['sector'] === 'string' && req.query['sector'].length <= 64 ? req.query['sector'] : null;
  res.json({ offers: pid && _provider ? _provider.offersFor(pid, sector) : [] });
});

economyRouter.get('/economy', (req: Request, res: Response) => {
  const pid = playerIdOf(req);
  if (!pid || !_provider) {
    res.json({ econVersion: 0, rep: { drones: 0, robots: 0, traders: 0 }, deals: [], history: [] } satisfies PlayerEconomyView);
    return;
  }
  res.json(_provider.view(pid));
});
