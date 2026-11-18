import type { Logger } from 'pino';
import type { SectorRoom } from '../rooms/SectorRoom.js';
import { persistence, getPersistence, getPlayerShipStore, getWallet } from '../db/PersistenceWorker.js';
import { getUser } from '../auth/AuthService.js';
import { LivingWorldDirector, LIVING_WORLD_BOT_COUNT, isLivingWorldDisabled, resolveBotSpoolMs, resolveBotHopMs, type LivingWorldOptions } from '../livingworld/LivingWorldDirector.js';
import { setIncomingPlayerSink } from '../livingworld/incomingPlayerSink.js';
import { setGalaxyStatsProvider } from '../livingworld/galaxyStatsProvider.js';
import { ROBOT_DIRECTOR_OPTIONS, ROBOT_BOT_COUNT, isRobotsDisabled } from '../livingworld/robotDirector.js';
import { RobotTerritory } from '../livingworld/RobotTerritory.js';
import { EliteDirector } from '../livingworld/EliteDirector.js';
import { FlagshipDirector, type FlagshipStatePayload } from '../livingworld/FlagshipDirector.js';
import { EventDirector } from '../livingworld/EventDirector.js';
import { sumCounts } from '../livingworld/countMaps.js';
import { setContractsProvider } from '../livingworld/contractsProvider.js';
import { BountyBoard, setBountyBoard } from '../economy/BountyBoard.js';
import { DirectorPersistence, type DirectorStatePayload } from '../livingworld/DirectorPersistence.js';
import { db } from '../db/Database.js';
import { getTeleportBroker } from '../teleport/TeleportBroker.js';
import type { WorldHandles } from './worldHandles.js';

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

/**
 * Boot step 5 — the Living World: drone + robot directors, robot territory,
 * flagship fleets, elites, world events and the Contracts board. Fills the
 * director fields of `world`; leaves them null when a kill switch is set.
 */
export function startLivingWorld(deps: { logger: Logger; galaxyRooms: Map<string, SectorRoom>; world: WorldHandles }): void {
  const { logger, galaxyRooms, world } = deps;
  if (isLivingWorldDisabled()) {
    logger.warn(
      { sectors: galaxyRooms.size },
      'living world DISARMED — no hunter bots will spawn or hunt (EQX_DISABLE_LIVING_WORLD set); unset + restart to re-arm',
    );
  } else {
    // Drone-squad spool follows the production `SPOOL_DURATION_MS` (5 min)
    // unless `EQX_BOT_SPOOL_MS` injects a faster value (E2E convergence); the
    // per-hop inter-sector flight uses the `hopTravelMs` default unless
    // `EQX_BOT_HOP_MS` injects a faster value.
    const botSpoolMs = resolveBotSpoolMs();
    const botHopMs = resolveBotHopMs();
    const directorOpts: Partial<LivingWorldOptions> = {};
    if (botSpoolMs !== undefined) directorOpts.spoolMs = botSpoolMs;
    if (botHopMs !== undefined) directorOpts.hopTravelMs = botHopMs;
    // Phase 5 — director-state persistence ("restart from any state"): shadow the
    // abstract squad continuity on the CRITICAL lane (same model as Limbo/roster)
    // and hydrate it from the read-only main-thread connection inside start(). The
    // singleton director_state row's table is created by the worker's schema
    // bootstrap (initWorker, above); a first-boot SELECT miss is caught in
    // hydrate() → fresh seed.
    const directorPersistence = new DirectorPersistence({
      saveRow: (payload: DirectorStatePayload) => {
        persistence.enqueueCritical({
          type: 'DIRECTOR_STATE_PUT',
          payloadJson: JSON.stringify(payload),
          ts: Date.now(),
        });
      },
      // The wave E2E server (EQX_E2E_WAVE=1) starts the director fresh: a
      // restored squad already assigned to the test base, or the faction's
      // last dispatch time (5-min cadence), meant a run a minute after the
      // previous one drew no wave (2026-11-08).
      loadRow: () =>
        process.env['EQX_E2E_WAVE'] === '1'
          ? undefined
          : (db
              .prepare('SELECT payload_json, created_at FROM director_state WHERE id = 1')
              .get() as { payload_json: string; created_at: number } | undefined),
      logger,
    });
    // Living World P1b — the ROBOT side: a second director instance (mixed-tier
    // `rbot-` squads, roam-only, hostile on sight via the stance table). Its
    // own persistence row lives in `allegiance_director_state`.
    if (isRobotsDisabled()) {
      logger.warn('robot director DISARMED (EQX_DISABLE_ROBOTS set)');
    } else {
      const robotPersistence = new DirectorPersistence({
        saveRow: (payload: DirectorStatePayload) => {
          persistence.enqueueCritical({
            type: 'ALLEGIANCE_DIRECTOR_STATE_PUT',
            allegiance: 'robots',
            payloadJson: JSON.stringify(payload),
            ts: Date.now(),
          });
        },
        loadRow: () =>
          db
            .prepare("SELECT payload_json, created_at FROM allegiance_director_state WHERE allegiance = 'robots'")
            .get() as { payload_json: string; created_at: number } | undefined,
        logger,
      });
      // Living World P3 — robot territory + nexus + every side's sector control.
      // Built first so its meter rides the director's state row (restored in start()).
      const territory = new RobotTerritory(galaxyRooms, () => world.robotDirector?.activeBotCountsBySector() ?? EMPTY_COUNTS);
      world.robotDirector = new LivingWorldDirector(galaxyRooms, {
        ...directorOpts,
        ...ROBOT_DIRECTOR_OPTIONS,
        directorPersistence: robotPersistence,
        hooks: {
          respawnAnchor: () => territory.respawnAnchor(),
          onTick: (now) => territory.tick(now),
          saveSectorControl: () => territory.saveControl(),
          restoreSectorControl: (entries) => territory.restoreControl(entries),
        },
      });
      world.robotDirector.start();
      // v4 T3 — teleporters carry robot bots across sectors.
      const rdMover = world.robotDirector;
      getTeleportBroker().addBotMover((id, from, to, x, y) => rdMover.teleportBot(id, from, to, x, y));
      territory.start();
      world.robotTerritory = territory;
      logger.info({ bots: ROBOT_BOT_COUNT, nexus: territory.nexusState() }, 'robot director started');
    }
    world.livingWorldDirector = new LivingWorldDirector(galaxyRooms, {
      ...directorOpts,
      directorPersistence,
      // Robots are enemies of every player on the galaxy map.
      hooks: {
        // Robots are hostile to every player on sight: the robot director's bots
        // AND an active incursion's raiders both show as enemies on the map.
        extraEnemyCounts: () => sumCounts(world.robotDirector?.activeBotCountsBySector() ?? EMPTY_COUNTS, world.eventDirector?.hostileCountsBySector() ?? EMPTY_COUNTS),
        // The control meter's holder for every side (null = neutral).
        sectorOwner: (key) => (world.robotTerritory ? world.robotTerritory.sectorOwner(key) : undefined),
        // P4a — named elites: ticked on the drone director's control loop and
        // marked on the galaxy map.
        onTick: (now) => {
          world.eliteDirector?.tick(now);
          world.flagshipDirector?.tick(now);
          world.eventDirector?.tick(now);
        },
        sectorElite: (key) => world.eliteDirector?.sectorElite(key) ?? null,
        // W2a — flagship fleets show as capital sightings on the galaxy map.
        sectorCapital: (key) => world.flagshipDirector?.sectorCapital(key) ?? null,
        // P4b — world events show on the galaxy map.
        sectorEvent: (key) => world.eventDirector?.sectorEvent(key) ?? null,
      },
    });
    // W2a — flagship fleets: capital ships + escorts roaming pocket to pocket
    // (solar-system sectors). Persisted in allegiance_director_state ('flagships').
    if (process.env['EQX_DISABLE_FLAGSHIPS'] === '1' || process.env['EQX_DISABLE_FLAGSHIPS'] === 'true') {
      logger.warn('flagship fleets DISARMED (EQX_DISABLE_FLAGSHIPS set)');
    } else {
      let restore: FlagshipStatePayload | null = null;
      try {
        const row = db
          .prepare("SELECT payload_json, created_at FROM allegiance_director_state WHERE allegiance = 'flagships'")
          .get() as { payload_json: string; created_at: number } | undefined;
        if (row && Date.now() - row.created_at < 24 * 60 * 60 * 1000) restore = JSON.parse(row.payload_json) as FlagshipStatePayload;
      } catch (err) {
        logger.warn({ err }, 'flagship state unreadable — fresh fleets');
      }
      world.flagshipDirector = new FlagshipDirector(galaxyRooms, {
        restore,
        save: (payload) => persistence.enqueueCritical({
          type: 'ALLEGIANCE_DIRECTOR_STATE_PUT', allegiance: 'flagships', payloadJson: JSON.stringify(payload), ts: Date.now(),
        }),
      });
      world.flagshipDirector.start();
    }
    world.eliteDirector = new EliteDirector(galaxyRooms);
    world.eliteDirector.start();
    world.eventDirector = new EventDirector(galaxyRooms);
    world.eventDirector.start();
    // P4c — the Contracts board reads the live elites + event.
    const ed = world.eliteDirector;
    const evd = world.eventDirector;
    // P4c-2 — player bounties: paid from the wallet, the board persisted as
    // one economy-state record (economy v2 W1).
    const bounties = new BountyBoard(getWallet(), getPersistence, {
      maxShipLevel: (pid) => getPlayerShipStore().listByPlayer(pid).reduce((m, r) => Math.max(m, r.level), 0),
      nameOf: (pid) => {
        const uid = getPlayerShipStore().listByPlayer(pid).find((r) => r.userId !== null)?.userId ?? null;
        const u = uid ? getUser(uid) : null;
        return u ? (u.displayName ?? null) : null;
      },
      lastSectorOf: (pid) => getPlayerShipStore().listByPlayer(pid)[0]?.lastSectorKey ?? null,
    });
    const bountyRow = db
      .prepare("SELECT payload_json FROM economy_state WHERE key = 'bounties'")
      .get() as { payload_json: string } | undefined;
    bounties.hydrate(bountyRow?.payload_json);
    setBountyBoard(bounties);
    setContractsProvider({ elites: () => ed.elites(), activeEvent: () => evd.activeEvent(), bounties: () => bounties.open() });
    world.livingWorldDirector.start();
    // v4 T3 — teleporters carry drone bots across sectors.
    const lwMover = world.livingWorldDirector;
    getTeleportBroker().addBotMover((id, from, to, x, y) => lwMover.teleportBot(id, from, to, x, y));
    // Phase-4 P0 — let the per-room TransitOrchestrator + destination rooms feed
    // inbound PLAYERS into the director's IncomingRegistry (the "incoming" banner)
    // without an import cycle. Null when the Living World is disabled.
    setIncomingPlayerSink(world.livingWorldDirector);
    // Phase-3 — serve live per-sector counts at GET /galaxy/snapshot from the
    // director's control-tick cache (null when the Living World is disabled).
    setGalaxyStatsProvider(world.livingWorldDirector);
    logger.info(
      {
        sectors: galaxyRooms.size,
        bots: LIVING_WORLD_BOT_COUNT,
        botSpoolMs: botSpoolMs ?? 'default',
        botHopMs: botHopMs ?? 'default',
      },
      'living world director started',
    );
  }
}
