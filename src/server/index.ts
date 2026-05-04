import 'dotenv/config';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';
import { getRecentEvents, clearEvents } from './debug/ServerEventLog.js';
import { authRouter } from './routes/authRouter.js';
import { diagRouter } from './routes/diagRouter.js';

const logger = pino({
  name: 'server',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const PORT = Number(process.env['PORT'] ?? 2567);
const MAX_DEV_EVENTS = 500;

const app = express();

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  next();
});

app.options('*', (_req, res) => { res.sendStatus(204); });

// 2 MB body limit matches the diag/capture route's MAX_BYTES ceiling. Default
// Express limit is 100 KB, which 413's any non-trivial diagnostic capture
// (a 500-entry log + server events is ~150 KB+).
app.use(express.json({ limit: '2mb' }));
app.use('/auth', authRouter);

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', tick: Date.now() });
});

// Dev-only endpoints for E2E test inspection and debugging.
if (process.env['NODE_ENV'] !== 'production') {
  app.post('/test/burn', (_req, res) => {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { /* intentional busy-wait */ }
    res.json({ ok: true });
  });

  // GET /dev/events?limit=N — recent server events (snapshots, joins, leaves).
  app.get('/dev/events', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 200), MAX_DEV_EVENTS);
    res.json({ events: getRecentEvents(limit) });
  });

  // POST /dev/events/clear — reset the ring buffer between test runs.
  app.post('/dev/events/clear', (_req, res) => {
    clearEvents();
    res.json({ ok: true });
  });

  // POST /diag/capture — accepts a JSON capture from a connected client and
  // writes it to diag/captures/<timestamp>-<id>.json. Used to diagnose mobile
  // reconciliation issues (and any other "play for a bit then capture" loop).
  // Files there are gitignored.
  app.use('/diag', diagRouter);
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('sector', SectorRoom, { maxClients: 16 });
gameServer.define('test-sector', SectorRoom, {
  testMode: true,
  asteroidConfig: [],
  maxClients: 8,
});
// Phase 5e soak room. swarmCount can be overridden per join via room
// options, but the default of 500 is the master plan's acceptance gate.
gameServer.define('swarm-soak', SectorRoom, {
  swarmCount: 500,
  swarmRatio: 0.8,
  swarmRadius: 18_000,
  maxClients: 8,
});
// Phase 6 TiDi acceptance gate. 4000 entities (3200 asteroids + 800 active
// drones at the 0.8 ratio). Diagnostic captures show this only consumes
// ~1.5 ms/tick on a typical dev machine — well under the 14 ms TiDi
// threshold — so TiDi will NOT engage here in steady state. Use this room
// to verify gameplay/feel at scale; use `swarm-tidi-burn` to verify the
// TiDi pipeline end-to-end.
gameServer.define('swarm-tidi', SectorRoom, {
  swarmCount: 4000,
  swarmRatio: 0.8,
  swarmRadius: 32_000,
  maxClients: 4,
});
// Phase 6 synthetic-load room. 16 ms/tick of busy-wait CPU burn pushes the
// server's `update()` comfortably over the 14 ms threshold so TiDi engages
// reliably for the acceptance E2E. Caveat (per Phase 6 testing notes):
// burns ≥ 16 ms slow the server's wall-clock tick cadence below 60 Hz,
// which makes the client's wall-clock-anchored input loop race ahead and
// produce a high reconciler-correction rate. That's expected for the
// acceptance test (which only asserts TiDi/shedder mechanics, not feel).
// Real production TiDi is driven by physics-side overruns (worker step),
// where the server thread stays at 60 Hz and no clock skew occurs.
gameServer.define('swarm-tidi-burn', SectorRoom, {
  swarmCount: 500, // smaller swarm so the burn dominates the budget signal
  swarmRatio: 0.8,
  swarmRadius: 18_000,
  tickBurnMs: 16,
  maxClients: 4,
});

httpServer.on('upgrade', (req) => {
  logger.info({ url: req.url }, 'WS upgrade received');
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'EQX Peri server started');
});
