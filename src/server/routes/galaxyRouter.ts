/**
 * Public route exposing the galaxy graph for the client landing screen and
 * the in-game galaxy-map overlay. Phase 8.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { GALAXY_SECTORS, DEFAULT_SECTOR_KEY } from '../../core/galaxy/galaxy.js';
import { buildGalaxySnapshot, getGalaxyStatsProvider } from '../livingworld/galaxyStatsProvider.js';

export const galaxyRouter: ExpressRouter = Router();

galaxyRouter.get('/sectors', (_req: Request, res: Response) => {
  res.json({ sectors: GALAXY_SECTORS, defaultSectorKey: DEFAULT_SECTOR_KEY });
});

/**
 * Live per-sector galaxy state (Living Galaxy Phase 3) — client polls every
 * 3–5 s. Served O(1) from the LivingWorldDirector's ~1.5 s control-tick cache
 * via the injected provider; falls back to the static graph with zero counts
 * when the Living World is disabled (`EQX_DISABLE_LIVING_WORLD`) or before the
 * director is wired. Not a live-loop path — no netgate.
 */
galaxyRouter.get('/snapshot', (_req: Request, res: Response) => {
  res.json(buildGalaxySnapshot(getGalaxyStatsProvider()));
});
