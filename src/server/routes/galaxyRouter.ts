/**
 * Public route exposing the galaxy graph for the client landing screen and
 * the in-game galaxy-map overlay. Phase 8.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { GALAXY_SECTORS, DEFAULT_SECTOR_KEY, getSector } from '../../core/galaxy/galaxy.js';
import { GALAXY_FEED_INTERVAL_MS } from '../../shared-types/galaxySnapshot.js';
import {
  buildGalaxyPresence,
  getGalaxyStatsProvider,
} from '../livingworld/galaxyStatsProvider.js';
import { getGalaxyFeed } from '../livingworld/galaxyFeed.js';
import { liveSectorHistory } from '../livingworld/RobotTerritory.js';
import { buildContracts, getContractsProvider } from '../livingworld/contractsProvider.js';

export const galaxyRouter: ExpressRouter = Router();

galaxyRouter.get('/sectors', (_req: Request, res: Response) => {
  res.json({ sectors: GALAXY_SECTORS, defaultSectorKey: DEFAULT_SECTOR_KEY });
});

/**
 * Live per-sector galaxy state (Living Galaxy Phase 3) — client polls every
 * GALAXY_FEED_INTERVAL_MS (10 s). Served O(1) from the LivingWorldDirector's ~1.5 s control-tick cache
 * via the injected provider; falls back to the static graph with zero counts
 * when the Living World is disabled (`EQX_DISABLE_LIVING_WORLD`) or before the
 * director is wired. Not a live-loop path — no netgate.
 */
/** Galaxy feed — the snapshot's public cache lifetime, matching the feed rebuild. */
const FEED_CACHE_CONTROL = `public, max-age=${GALAXY_FEED_INTERVAL_MS / 1000}`;

galaxyRouter.get('/snapshot', (_req: Request, res: Response) => {
  // Galaxy feed — one memoised body for every viewer, rebuilt every ~10 s (galaxyFeed.ts).
  res.setHeader('Cache-Control', FEED_CACHE_CONTROL);
  res.type('application/json').send(getGalaxyFeed().json());
});

/**
 * Galaxy feed — a sector's last hour of control (one sample a minute: holder +
 * holder share), oldest first. `:key` must be a known sector (else 404). Empty
 * samples while no control meter runs. Same public cache lifetime as the snapshot.
 */
galaxyRouter.get('/sector/:key/history', (req: Request, res: Response) => {
  const raw = req.params.key;
  const key = typeof raw === 'string' ? raw : '';
  if (key.length < 1 || key.length > 64 || !getSector(key)) {
    res.status(404).json({ error: 'unknown sector' });
    return;
  }
  res.setHeader('Cache-Control', FEED_CACHE_CONTROL);
  res.json({ key, samples: liveSectorHistory(key) ?? [] });
});

/**
 * Per-player galaxy presence (Equinox Phase 7) — the count of structures the
 * requesting player owns per sector, for the galaxy-map "my structures" overlay.
 * The client polls it every ~4 s alongside `/snapshot`; ship locations come from
 * the client's own roster and are merged in client-side. Computed on demand from
 * the live rooms (off the 60 Hz tick) — not a live-loop path, no netgate. The
 * `playerId` is bounded to 64 chars (S5 inbound-string-id rule); a missing /
 * over-long / no-provider request returns an empty list (the overlay shows
 * nothing rather than erroring).
 */
galaxyRouter.get('/presence', (req: Request, res: Response) => {
  const raw = req.query.playerId;
  const playerId = typeof raw === 'string' ? raw : '';
  if (playerId.length < 1 || playerId.length > 64) {
    res.json({ sectors: [] });
    return;
  }
  res.json(buildGalaxyPresence(getGalaxyStatsProvider(), playerId));
});

/**
 * Living World P4c — the Contracts board: live named elites (with their
 * bounty) and the running world event. The client's Contracts tab polls it
 * only while the tab is open; it is the tab's sole source of truth (#16).
 * Off the 60 Hz tick — no netgate.
 */
galaxyRouter.get('/contracts', (_req: Request, res: Response) => {
  res.json(buildContracts(getContractsProvider()));
});
