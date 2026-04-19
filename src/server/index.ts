import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'node:http';
import { pino } from 'pino';
import { SectorRoom } from './rooms/SectorRoom.js';

const logger = pino({
  name: 'server',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const PORT = Number(process.env['PORT'] ?? 2567);

const app = express();

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', tick: Date.now() });
});

// Deliberate 200 ms CPU stall used in Phase 2 E2E acceptance tests.
// Proves the physics worker keeps ticking even when the main thread is busy.
if (process.env['NODE_ENV'] !== 'production') {
  app.post('/test/burn', (_req, res) => {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { /* intentional busy-wait */ }
    res.json({ ok: true });
  });
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('sector', SectorRoom, { maxClients: 16 });

httpServer.on('upgrade', (req) => {
  logger.info({ url: req.url }, 'WS upgrade received');
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'EQX Peri server started');
});
