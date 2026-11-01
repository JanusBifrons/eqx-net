/**
 * The showcase reel: shot order, section cards, and the coverage bookkeeping
 * the `showcaseCoverage` unit test enforces. A new player-facing feature adds
 * a shot (and lists its doc in `docs`) or an entry in SHOWCASE_EXEMPT /
 * SHOWCASE_PENDING with a reason.
 */
import type { Shot } from './types.js';
import { galaxyLanding } from './shots/galaxyLanding.js';
import { joinSector } from './shots/joinSector.js';
import { shipGallery } from './shots/shipGallery.js';
import { flight } from './shots/flight.js';
import { beamCombat } from './shots/beamCombat.js';
import { turrets } from './shots/turrets.js';
import { missiles } from './shots/missiles.js';
import { packBattle } from './shots/packBattle.js';
import { scrap } from './shots/scrap.js';
import { buildBase } from './shots/buildBase.js';
import { gridAlive } from './shots/gridAlive.js';
import { defence } from './shots/defence.js';
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

/** Every shot, in reel order. Catalogue = all of them; reel = `reel: true`. */
export const SHOTS: readonly Shot[] = [
  galaxyLanding,
  joinSector,
  shipGallery,
  flight,
  beamCombat,
  turrets,
  missiles,
  packBattle,
  robots,
  nexus,
  scrap,
  loot,
  buildBase,
  gridAlive,
  defence,
  waveAttack,
  levelUp,
  spectator,
  warp,
  scale,
  proceduralBase,
  mobile,
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
  'off-screen-indicators': 'Visible in every minimal/full HUD combat shot (halo ring).',
  'cinematic-camera': 'The tool that films the video.',
  'showcase-pipeline': 'The pipeline itself.',
  'procedural-bases-research': 'Research record.',
};

/** Docs whose feature exists but cannot be staged on main yet — with what unblocks it. */
export const SHOWCASE_PENDING: Record<string, string> = {
  'structure-network-scale': 'Structure-scale measurement (plan soft-leaping-truffle v2 A0) — filmed once NPC bases built from real structures are seeded (phase D2); stills are in diag/showcase/structure-scale.',
  allegiances: 'AI-vs-AI sides fight in the living galaxy but not on cue; needs a staged two-faction room.',
  'trade-deals':
    'Trade needs a SIGNED-IN pilot and shots join anonymously (AS_PILOT); needs a logged-in take. ' +
    'Filmed standalone meanwhile: tests/showcase/trade-p2.spec.ts (room trade-showcase).',
  'economy-and-trade':
    'Same as trade-deals (signed-in take needed); standalone recording: tests/showcase/trade-p2.spec.ts.',
};
