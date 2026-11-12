/**
 * The showcase reel: shot order, section cards, and the coverage bookkeeping
 * the `showcaseCoverage` unit test enforces. A new player-facing feature adds
 * a shot (and lists its doc in `docs`) or an entry in SHOWCASE_EXEMPT /
 * SHOWCASE_PENDING with a reason.
 */
import type { Shot } from './types.js';
import { galaxyLanding } from './shots/galaxyLanding.js';
import { warpTo, warpPicker } from './shots/warpTo.js';
import { warpOnlooker, warpArrival } from './shots/warpOnlooker.js';
import { sectorTravel } from './shots/sectorTravel.js';
import { joinSector } from './shots/joinSector.js';
import { shipGallery } from './shots/shipGallery.js';
import { capitalFleetWarp, capitalFleetArrive, capitalLineup, capitalBroadside, capitalFlyby, capitalPilot, capitalEngines, capitalTurrets, capitalGunsFighter, capitalGunsBystander, gpuLitShips } from './shots/capitals.js';
import { machinedArt } from './shots/machinedArt.js';
import { newEffects } from './shots/newEffects.js';
import { crossingSector } from './shots/crossingSector.js';
import { machinedTurrets } from './shots/machinedTurrets.js';
import { flight } from './shots/flight.js';
import { beamCombat } from './shots/beamCombat.js';
import { turrets } from './shots/turrets.js';
import { missiles } from './shots/missiles.js';
import { packBattle } from './shots/packBattle.js';
import { longGuns } from './shots/longGuns.js';
import { fleetMelee } from './shots/fleetMelee.js';
import { timeScaleDial } from './shots/timeScaleDial.js';
import { scrap } from './shots/scrap.js';
import { buildBase } from './shots/buildBase.js';
import { gridAlive } from './shots/gridAlive.js';
import { defence } from './shots/defence.js';
import { coastalCatalogue, coastalAa, coastalDuel, coastalSuperGuns, garrisonDefences } from './shots/coastalDefences.js';
import { waveAttack } from './shots/waveAttack.js';
import { levelUp } from './shots/levelUp.js';
import { spectator } from './shots/spectator.js';
import { warp } from './shots/warp.js';
import { scale } from './shots/scale.js';
import { mobile } from './shots/mobile.js';
import { loot } from './shots/loot.js';
import { robots } from './shots/robots.js';
import { nexus } from './shots/nexus.js';
import { proceduralBase } from './shots/proceduralBase.js';
import { productionLine } from './shots/productionLine.js';
import { habitatStation } from './shots/habitatStation.js';
import { shieldGates } from './shots/shieldGates.js';
import { radar } from './shots/radar.js';
import { breakIn } from './shots/breakIn.js';
import { npcCitadel } from './shots/npcCitadel.js';
import { alienGate, garrisonPatrol, teleporterRide, transitHub } from './shots/v4.js';
import { tradeDeal, tradeRaid } from './shots/trade.js';
import { cockpitBounty, cockpitHaul, cockpitRobots, cockpitStronghold } from './shots/cockpit.js';
import { fireControlShots } from './shots/fireControl.js';

/** Every shot, in reel order. Catalogue = all of them; reel = `reel: true`. */
export const SHOTS: readonly Shot[] = [
  warpTo,
  warpPicker,
  warpOnlooker,
  warpArrival,
  sectorTravel,
  galaxyLanding,
  joinSector,
  shipGallery,
  capitalLineup,
  capitalBroadside,
  capitalFleetWarp,
  capitalFleetArrive,
  capitalFlyby,
  capitalPilot,
  capitalEngines,
  capitalTurrets,
  gpuLitShips,
  capitalGunsFighter,
  capitalGunsBystander,
  longGuns,
  machinedArt,
  flight,
  beamCombat,
  turrets,
  missiles,
  packBattle,
  fleetMelee,
  timeScaleDial,
  newEffects,
  crossingSector,
  machinedTurrets,
  robots,
  nexus,
  scrap,
  loot,
  cockpitHaul,
  cockpitBounty,
  cockpitRobots,
  cockpitStronghold,
  breakIn,
  tradeDeal,
  tradeRaid,
  buildBase,
  gridAlive,
  defence,
  coastalCatalogue,
  coastalAa,
  coastalDuel,
  coastalSuperGuns,
  garrisonDefences,
  shieldGates,
  waveAttack,
  levelUp,
  spectator,
  radar,
  warp,
  scale,
  proceduralBase,
  npcCitadel,
  productionLine,
  teleporterRide,
  transitHub,
  alienGate,
  garrisonPatrol,
  habitatStation,
  mobile,
  // Catalogue-only: the fire-control HUD takes (`pnpm showcase:fc`).
  ...fireControlShots,
];

export const SECTION_CARDS: Record<Shot['section'], { title: string; sub: string } | null> = {
  opener: null, // the title card opens the reel
  mechanics: { title: 'Gameplay', sub: 'Fly, fight, build and defend in a persistent multiplayer galaxy.' },
  tech: { title: 'Under the hood', sub: 'Server-authoritative simulation with client prediction, built for scale and for phones.' },
};

export const TITLE_SUB = 'Multiplayer space combat · gameplay & engine showcase';

/** Technical capabilities stated on the end card (not filmable on their own). */
export const END_CARD_POINTS: readonly string[] = [
  'Authoritative 60 Hz fixed-step physics (Rapier, worker thread)',
  'Client prediction + reconciliation, ~120 ms RTT playable',
  'Binary swarm wire + spatial interest management',
  'WebRTC DataChannel snapshots with WebSocket fallback',
  'OffscreenCanvas worker renderer on desktop',
  'Persistent sectors, bases, fleets and AI director (SQLite)',
  'Gameplay audit log + replayable diagnostic captures',
  'Netcode-health CI gate on every live-loop change',
];

/** Docs deliberately not filmed, with the reason. */
export const SHOWCASE_EXEMPT: Record<string, string> = {
  'pwa-and-push-notifications': 'Install prompt + push notification — not in-world footage.',
  'web-push': 'Server-side push delivery — not in-world footage.',
  security: 'Infrastructure — no visible surface.',
  'perf-scenes': 'Test tooling — the scenes are measured, not filmed (any can be played with the camera on).',
  relations: 'A shared rule (who is hostile to whom) with no visible surface of its own; gates, turrets and cargo show its effects.',
  'persistence-and-migrations': 'Covered by an end-card line until the persistence shot lands (SHOWCASE_PENDING).',
  'gameplay-audit-log': 'Tooling — end-card line.',
  'diagnostic-captures': 'Tooling — end-card line.',
  'e2e-framework': 'Test tooling — no in-game surface.',
  'player-identity': 'Account-bound identity — invisible to a viewer by design.',
  'scenario-harness': 'Test tooling — no in-game surface.',
  'perf-device-capture': 'Perf tooling — no in-game surface.',
  'mobile-perf-investigation-review': 'Investigation record.',
  'mobile-perf-probe-0-results': 'Investigation record.',
  'memory-allocation-paradigm': 'Engineering discipline — end-card adjacent.',
  'reconciler-replay-scaling': 'Prediction internals — represented by the end card.',
  'prediction-and-correction': 'Prediction internals — represented by the end card (netcode shot is pending).',
  'remote-prediction': 'Prediction internals — represented by the end card.',
  'collision-events': 'Physics internals — visible inside combat/scrap shots.',
  'collision-layers': 'Physics internals — visible inside combat/scrap shots.',
  'asteroid-interaction-model': 'Visible incidentally (mining, scale shot).',
  'webrtc-datachannel-snapshot-transport': 'Off under automation; end-card line.',
  'cinematic-camera': 'The tool that films the video.',
  'showcase-pipeline': 'The pipeline itself.',
  'procedural-bases-research': 'Research record.',
  'shell-events': 'Design note, no player-facing change yet; the shells and incoming-fire marker it changes are filmed by the real-scale-ranges shot once built.',
  'hud-variants': 'historical: HUD variants retired (fire control is the only HUD since 2026-11-09).',
};

/** Docs whose feature exists but cannot be staged on main yet — with what unblocks it. */
export const SHOWCASE_PENDING: Record<string, string> = {
  'real-scale-ranges': 'Off by default (EQX_NAVAL_RANGE=real); filmed with the coastal-duel shot once the camera can show a 30 km shot (follow-up slice).',
  'contacts-overview':
    'The list earns its place on a capital at real-scale range (16" at 30 km); film it beside the real-scale-ranges shot once that 30 km camera lands, opening the list and locking a far fighter from it.',
  'ship-scale': 'R&D: the 1×/2×A/2×B comparison clips are filmed by running existing shots at EQX_SHIP_SCALE; a dedicated shot lands with the rollout.',
  allegiances: 'AI-vs-AI sides fight in the living galaxy but not on cue; needs a staged two-faction room.',
  factions:
    'The Factions tab (v4 F3) shows standings; a meaningful shot needs a staged room with non-zero standings both ways and a turret firing on a disliked pilot.',
  blueprints:
    'Blueprints drop at random from elites/events and install at a signed-in base; needs a staged loot→install room for the P5 showcase.',
  'research-lab':
    'Lab jobs run for minutes on the 1 Hz grid pulse; needs a staged base with blueprints + a fast-pulse room before it can be filmed.',
};
