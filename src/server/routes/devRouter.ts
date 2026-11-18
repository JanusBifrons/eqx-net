/**
 * Dev-only HTTP endpoints for E2E test inspection and debugging (`/test/burn`,
 * `/dev/*`, and the `/diag` capture router). Moved out of `index.ts` (god-file
 * split). Disabled when `NODE_ENV === 'production'`: the index.ts mount is gated.
 * The directors are built in `main()` after boot, so they are read through
 * getters at request time.
 */
import { Router, type Router as ExpressRouter } from 'express';
import { matchMaker } from 'colyseus';
import type { SectorRoom } from '../rooms/SectorRoom.js';
import { scenePerfViews, recordClientReading, clientPerfReadings } from '../rooms/scene/scenePerfRegistry.js';
import { getRecentEvents, getRecentEventsByTag, clearEvents } from '../debug/ServerEventLog.js';
import { diagRouter, devStatsHandler, devLimboHandler, devPlayerShipsHandler, devPlayerShipsAbandonHandler, devResetSectorHandler, devResetRosterHandler, devWebrtcCountersHandler } from './diagRouter.js';
import { devAuditHandler } from '../audit/auditRoute.js';
import { WORLD_EVENT_KINDS, type WorldEventKind } from '../../shared-types/worldEvents.js';
import type { ConvoyDirector } from '../economy/ConvoyDirector.js';
import type { LivingWorldDirector } from '../livingworld/LivingWorldDirector.js';
import type { EventDirector } from '../livingworld/EventDirector.js';

// Default 500; bump via `EQX_DEV_EVENTS_MAX` to match the ring's actual size
// when ServerEventLog is configured larger (e.g. diagnostic captures).
const MAX_DEV_EVENTS = Number(process.env['EQX_DEV_EVENTS_MAX'] ?? 500);

/** Live server state the dev endpoints read (null until boot finishes). */
export interface DevRouterDeps {
  convoyDirector: () => ConvoyDirector | null;
  livingWorldDirector: () => LivingWorldDirector | null;
  robotDirector: () => LivingWorldDirector | null;
  eventDirector: () => EventDirector | null;
}

/** Builds the dev router; index.ts mounts it at the root outside production. */
export function createDevRouter(deps: DevRouterDeps): ExpressRouter {
  const router = Router();
  router.post('/test/burn', (_req, res) => {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { /* intentional busy-wait */ }
    res.json({ ok: true });
  });

  // T2 — convoys in flight (phase, hauler pose, target).
  // GET /dev/perf — perf-scene rooms: scene status, server tick cost, counts.
  router.get('/dev/perf', (_req, res) => {
    res.json({ rooms: scenePerfViews() });
  });

  // Perf lab: a device posts its reading when a scene ends; GET lists them.
  router.post('/dev/perf/client', (req, res) => {
    const file = recordClientReading({ ...(req.body as object), receivedAt: new Date().toISOString(), rooms: scenePerfViews() });
    res.json({ ok: true, saved: file !== null });
  });
  router.get('/dev/perf/client', (_req, res) => {
    res.json({ readings: clientPerfReadings() });
  });

  router.get('/dev/convoys', (_req, res) => {
    res.json({ convoys: deps.convoyDirector()?.debugView() ?? [] });
  });

  // GET /dev/events?limit=N — recent server events (snapshots, joins, leaves).
  router.get('/dev/events', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 200), MAX_DEV_EVENTS);
    // ?tag= returns the newest matching entries from the whole ring.
    const tag = typeof req.query['tag'] === 'string' ? req.query['tag'] : undefined;
    res.json({ events: tag ? getRecentEventsByTag(tag, limit) : getRecentEvents(limit) });
  });

  // POST /dev/events/clear — reset the ring buffer between test runs.
  router.post('/dev/events/clear', (_req, res) => {
    clearEvents();
    res.json({ ok: true });
  });

  // POST /diag/capture — accepts a JSON capture from a connected client and
  // writes it to diag/captures/<timestamp>-<id>.json. Used to diagnose mobile
  // reconciliation issues (and any other "play for a bit then capture" loop).
  // Files there are gitignored.
  router.use('/diag', diagRouter);

  // GET /dev/stats?email=foo — kill/death counts for a user. Phase 7 E2E gate.
  router.get('/dev/stats', devStatsHandler);

  // GET /dev/limbo?playerId=foo — Phase 8 sub-phase B Limbo inspection.
  router.get('/dev/limbo', devLimboHandler);

  // GET /dev/webrtc-counters?roomId=<colyseus-roomId> — Phase 4 iteration 3
  // swift-otter diagnostic. Returns the room's per-session WebRTC counters
  // (sentViaDc / sentViaWs / degraded / dcThrows / etc) so the Phase 4
  // E2E can localise DC throughput variance.
  router.get('/dev/webrtc-counters', (req, res) => {
    void devWebrtcCountersHandler(req, res);
  });

  // GET /dev/memory — where the server's memory goes: the process (rss, V8
  // heap, external/array buffers) and each room's physics worker heap. Found
  // 2026-11-07: an idle dev server held ~1.7 GB, ~37 MB of it per sector
  // worker before any body exists.
  // `?gc=1` collects garbage first (main thread + each physics worker), so the
  // reading is what is live, not what V8 has not collected yet. Needs the
  // server started with --expose-gc (scripts/soak-galaxy.ts does); else a no-op.
  router.get('/dev/memory', (req, res) => {
    void (async () => {
      const MB = 1048576;
      const gc = req.query['gc'] === '1';
      if (gc) (globalThis as { gc?: () => void }).gc?.();
      const m = process.memoryUsage();
      const listings = await matchMaker.query({});
      const gcDone = new Set<number>();
      const rooms: Array<{ room: string; roomId: string; clients: number; worker: number | null }> = [];
      const workers = new Map<number, number>(); // pool worker → heap MB (shared by its rooms)
      for (const l of listings) {
        const r = matchMaker.getLocalRoomById(l.roomId) as unknown as SectorRoom | undefined;
        // One collection per pool worker (several rooms share one).
        const idx = r && typeof r.workerHeapStats === 'function' ? (await r.workerHeapStats(false))?.workerIndex : undefined;
        const wantGc = gc && idx !== undefined && !gcDone.has(idx);
        if (wantGc) gcDone.add(idx);
        const h = r && typeof r.workerHeapStats === 'function' ? await r.workerHeapStats(wantGc) : null;
        if (h) workers.set(h.workerIndex, Math.round(h.usedBytes / MB));
        rooms.push({ room: l.name, roomId: l.roomId, clients: l.clients, worker: h ? h.workerIndex : null });
      }
      res.json({
        rssMb: Math.round(m.rss / MB), heapUsedMb: Math.round(m.heapUsed / MB), heapTotalMb: Math.round(m.heapTotal / MB),
        externalMb: Math.round(m.external / MB), arrayBuffersMb: Math.round(m.arrayBuffers / MB),
        rooms: rooms.length, physicsWorkers: workers.size,
        workerHeapMb: Object.fromEntries(workers), workerHeapTotalMb: [...workers.values()].reduce((s, v) => s + v, 0),
        perRoom: rooms,
      });
    })().catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });

  // GET /dev/population — Living World director snapshot (per-sector
  // players/bots, totals, in-transit/respawning) for E2E + diagnostics.
  // Read-only; mirrors /dev/limbo's inspection-only shape.
  router.get('/dev/population', (req, res) => {
    // `?allegiance=robots` inspects the robot director (Living World P1b).
    const d = req.query['allegiance'] === 'robots' ? deps.robotDirector() : deps.livingWorldDirector();
    res.json(d ? d.snapshot() : { ready: false });
  });

  // POST /dev/world-event/start?kind=incursion|mothership|salvage&sector=<key>
  // — Living World P4b test trigger: start a world event now (no 9-min lull).
  router.post('/dev/world-event/start', (req, res) => {
    const kind = String(req.query['kind'] ?? '');
    const sector = String(req.query['sector'] ?? '');
    const eventDirector = deps.eventDirector();
    if (!eventDirector || !(WORLD_EVENT_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ ok: false });
      return;
    }
    res.json({ ok: eventDirector.startEvent(kind as WorldEventKind, sector), event: eventDirector.activeEvent() });
  });

  // GET /dev/time-scale — every live sector's game speed (time scale stream).
  // POST /dev/time-scale?room=<roomId|sectorKey>&scale=N — set one sector's
  // speed (0.25–4), e.g. for a demo, a video or slow motion.
  const timeScaleRooms = async (): Promise<SectorRoom[]> => {
    const out: SectorRoom[] = [];
    for (const l of await matchMaker.query({})) {
      const r = matchMaker.getLocalRoomById(l.roomId) as unknown as SectorRoom | undefined;
      if (r && typeof r.setTimeScale === 'function') out.push(r);
    }
    return out;
  };
  router.get('/dev/time-scale', (_req, res) => {
    void timeScaleRooms().then((rooms) => res.json({
      rooms: rooms.map((r) => ({ roomId: r.roomId, sectorKey: r.timeScaleSectorKey(), timeScale: r.gameClock.scale })),
    })).catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });
  router.post('/dev/time-scale', (req, res) => {
    const target = String(req.query['room'] ?? '');
    const scale = Number(req.query['scale']);
    if (!target || !Number.isFinite(scale) || scale <= 0) { res.status(400).json({ ok: false }); return; }
    void timeScaleRooms().then((rooms) => {
      const r = rooms.find((x) => x.roomId === target || x.timeScaleSectorKey() === target);
      if (!r) { res.status(404).json({ ok: false }); return; }
      // Glides there like a dimmer; `&snap=1` jumps at once.
      res.json({ ok: true, roomId: r.roomId, timeScale: r.setTimeScale(scale, req.query['snap'] !== '1') });
    }).catch((err: unknown) => res.status(500).json({ error: String(err) }));
  });

  // GET /dev/audit?player=&owner=&sector=&event=&since=&until=&limit=&source=&format=
  // — query the gameplay audit log (durable NDJSON history + live ring tail).
  // Answers "what happened to my base?" from the running server. The audit
  // WRITE path is NOT gated (runs in normal play); only this read endpoint is.
  router.get('/dev/audit', (req, res) => {
    void devAuditHandler(req, res);
  });

  // GET /dev/player-ships?playerId=foo — Phase 2 multi-ship roster
  // inspection. Returns the player's full roster (up to 10 entries).
  router.get('/dev/player-ships', devPlayerShipsHandler);

  // POST /dev/player-ships/:shipId/abandon — Phase 3 roster abandonment.
  // Body: { playerId: string }. Drops a stored / lingering ship from the
  // roster. Returns 409 when the ship is currently active.
  router.post('/dev/player-ships/:shipId/abandon', devPlayerShipsAbandonHandler);

  // POST /dev/reset-sector?key=<roomName> — surgical reset for smoke testing.
  // Wipes one (or all) sector's in-memory + persisted swarm state and forces
  // a fresh re-spawn. See diagRouter.ts for the full mechanism.
  router.post('/dev/reset-sector', (req, res) => {
    void devResetSectorHandler(req, res);
  });

  // POST /dev/reset-roster — wipe a player's roster rows. Used by the
  // happy-path UI E2E to ensure a known-empty starting roster.
  router.post('/dev/reset-roster', devResetRosterHandler);
  return router;
}
