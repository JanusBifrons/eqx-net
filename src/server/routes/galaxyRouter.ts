/**
 * Public route exposing the galaxy graph for the client landing screen and
 * the in-game galaxy-map overlay. Phase 8.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { GALAXY_SECTORS, DEFAULT_SECTOR_KEY } from '../../core/galaxy/galaxy.js';

export const galaxyRouter: ExpressRouter = Router();

galaxyRouter.get('/sectors', (_req: Request, res: Response) => {
  res.json({ sectors: GALAXY_SECTORS, defaultSectorKey: DEFAULT_SECTOR_KEY });
});
