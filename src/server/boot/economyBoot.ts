import type { Logger } from 'pino';
import type { SectorRoom } from '../rooms/SectorRoom.js';
import { setEconomyRouteProvider } from '../routes/economyRouter.js';
import { EconomyStore, hydrateEconomyStore } from '../economy/EconomyStore.js';
import { TradeDirector } from '../economy/TradeDirector.js';
import { getTradeSink, setTradeSink } from '../economy/tradeSink.js';
import { ConvoyDirector, isConvoysDisabled } from '../economy/ConvoyDirector.js';
import { isNpcBasesDisabled } from '../bases/NpcBaseSubsystem.js';
import { pushNotifier } from '../push/PushNotifier.js';
import { getPersistence, getHoldStore, getPlayerShipStore, getWallet } from '../db/PersistenceWorker.js';
import { getUser } from '../auth/AuthService.js';
import { getSector } from '../../core/galaxy/galaxy.js';
import { db } from '../db/Database.js';
import type { WorldHandles } from './worldHandles.js';

/**
 * Boot step 6 — the economy: market, trade director, NPC-base convoys and the
 * /trade route provider. Fills the economy fields of `world`.
 */
export function startEconomy(deps: { logger: Logger; galaxyRooms: Map<string, SectorRoom>; world: WorldHandles }): void {
  const { logger, galaxyRooms, world } = deps;
  // Living World P2 — the economy: market, reputation, trade deals carried by
  // physical haulers. Independent of the squad directors (trade still runs when
  // the Living World kill switch is set). Hydrate BEFORE start(): the director's
  // boot reconcile unwinds any run that was in flight when the server stopped.
  world.economyStore = new EconomyStore({ persistence: getPersistence });
  const econ = hydrateEconomyStore(world.economyStore, (sql) => db.prepare(sql).all());
  world.tradeDirector = new TradeDirector(galaxyRooms, world.economyStore, getHoldStore(), {
    push: (pid, title, body, tag) => pushNotifier.notifyTrade(pid, title, body, tag),
    wallet: getWallet(),
  });
  world.tradeDirector.start();
  setTradeSink(world.tradeDirector);
  // T2 (plan soft-leaping-truffle v3) — convoys between the galaxy's NPC bases.
  if (!isConvoysDisabled() && !isNpcBasesDisabled()) {
    const convoyRooms = new Map<string, SectorRoom>();
    for (const [key, room] of galaxyRooms) if (getSector(key)) convoyRooms.set(key, room);
    world.convoyDirector = new ConvoyDirector(convoyRooms, getHoldStore(), undefined, undefined, { wallet: getWallet(), sink: getTradeSink });
    world.convoyDirector.start();
  }
  const store = world.economyStore;
  const director = world.tradeDirector;
  setEconomyRouteProvider({
    offersFor: (pid, sector) => director.offersFor(pid, sector),
    view: (pid) => store.view(pid),
    factions: (pid) => store.factionsView(pid, (other) => {
      const uid = getPlayerShipStore().listByPlayer(other).find((r) => r.userId !== null)?.userId ?? null;
      const u = uid ? getUser(uid) : null;
      return u?.displayName ?? u?.email ?? 'A pilot';
    }),
  });
  logger.info(econ, 'trade director started');
}
