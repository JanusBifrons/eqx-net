import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import {
  initWorker,
  initPlayerShipStore,
  initHoldStore,
  initAccountPlayerRegistry,
  initWallet,
  initLabBoard,
  migrateLegacyHoldCredits,
} from '../db/PersistenceWorker.js';

/** Boot step 1 — spawn the persistence worker (creates the schema). */
export async function startPersistenceWorker(deps: { logger: Logger }): Promise<void> {
  const { logger } = deps;
  const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'eqx.db');
  await initWorker({ dbPath });
  logger.info({ dbPath }, 'persistence worker READY');
}

/** Boot step 2 — open the HTTP/WS port. Resolves once listening. */
export async function listenHttp(deps: { logger: Logger; httpServer: HttpServer; port: number }): Promise<void> {
  const { logger, httpServer } = deps;
  const PORT = deps.port;
  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'EQX Peri server started');
      resolve();
    });
  });
}

/**
 * Boot step 3 — hydrate the main-thread stores (roster, holds, identity,
 * wallets, lab). Must run BEFORE the galaxy rooms are created.
 */
export function hydratePlayerStores(deps: { logger: Logger }): void {
  const { logger } = deps;
  // Phase 2 multi-ship roster — same boot ordering. Reads the
  // `player_ships` rows and seeds the in-memory PlayerShipStore so any
  // galaxy room's onJoin can resolve a shipId without a race.
  const { hydrated: rosterHydrated } = initPlayerShipStore();
  logger.info({ hydrated: rosterHydrated }, 'Player-ship roster hydrated from disk');

  // Living World P1a — the unified hold table (ship cargo, loot pods, storage).
  // BEFORE the galaxy rooms: their hydrate respawns this sector's loot pods.
  const { hydrated: holdsHydrated } = initHoldStore();
  logger.info({ hydrated: holdsHydrated }, 'Holds hydrated from disk');

  // PR 3a — account-bound player identity. Hydrate the account→playerId
  // bindings + aliases and fold each account's historical per-browser ids
  // into one canonical playerId. AFTER the roster (re-keys rows), BEFORE the
  // galaxy rooms (they map persisted owners through the registry on hydrate).
  const identity = initAccountPlayerRegistry();
  logger.info(identity, 'Account-bound player identity hydrated + merged');

  // Economy v2 W1 — the virtual wallet (credits are never in holds). Hydrate
  // AFTER the identity merge (rows fold onto canonical ids), then move any
  // pre-wallet hold credits into their owners' wallets (one-time, idempotent).
  const { hydrated: walletsHydrated } = initWallet();
  const migrated = migrateLegacyHoldCredits();
  logger.info({ wallets: walletsHydrated, ...migrated }, 'Wallets hydrated (+ legacy hold credits migrated)');
  // Economy v2 W3 — the running Research Lab jobs (they hold their blueprints).
  logger.info(initLabBoard(), 'Research Lab jobs hydrated');
}
