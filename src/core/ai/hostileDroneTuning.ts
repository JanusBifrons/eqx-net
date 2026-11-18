/**
 * Tuning numbers and pure-data types for the hostile AI pilot
 * (`HostileDroneBehaviour.ts`). Values only: no logic lives here.
 */
import { shipBubbleRadius } from '../combat/shipHitShape.js';
import type { PLAYERS_SIDE } from '../../shared-types/allegiances.js';
import { DEFAULT_PILOT_PARAMS, type PilotParams } from './virtualPilot.js';
import { MORALE_LOCK_TICKS, type MoraleInputs, type MoraleOutcome, type MoraleWeights } from './tactics/morale.js';

/** Aim cone (radians). Drones won't fire unless their nose is within this many radians of the target. */
export const DRONE_AIM_TOLERANCE = 0.25; // ~14°
/** Wider fire arc used when the target is at point-blank (`< 0.4 ×
 *  DRONE_FIRE_RANGE`). At brawl distance even an off-cone shot tends to
 *  connect, so drones get to be more aggressive. */
export const DRONE_AIM_TOLERANCE_CLOSE = 0.45; // ~26°
/** Distance threshold (relative to fire range) below which the wide
 *  point-blank arc kicks in. */
export const POINT_BLANK_RATIO = 0.4;

/** A target view with no hit radius (tests, older callers) is aimed at as the
 *  default kind's shield bubble (the shared hit shape, #18). */
export const DEFAULT_AIM_RADIUS = shipBubbleRadius(null);

/** Distance threshold (relative to fire range) above which the drone
 *  gets a thrust boost to close engagement faster. Tuned so the boost
 *  fires only when the drone is meaningfully out of combat range. */
export const ENGAGE_DISTANCE_RATIO = 1.5;
/** Capital broadside (Phase 3): hold this fraction of main-battery reach. */
export const BROADSIDE_STANDOFF = 0.75;
/** Max heading bias (rad) toward / away from the target to keep the stand-off. */
export const BROADSIDE_RANGE_STEER = 0.6;
/** Speed while broadside, per unit of range error (fraction of cruise). */
export const BROADSIDE_SPEED = 0.6;
/** Within this share of the stand-off either side the capital is AT its
 *  stand-off: beam straight on, keys off, the hull rests. Without it a range a
 *  few tens of units off asked for a sub-1 u/s creep along the beam (which
 *  barely changes the range), the pilot kept tapping thrust and the hull never
 *  rested, so its pose went out every tick (perf scene capital-duel, PR #549:
 *  swarm wire 0.24 → 3.1 KB/s). Outside the band the error is measured from
 *  its edge, so heading bias and speed still start from zero. */
export const BROADSIDE_RANGE_DEADBAND = 0.05;
/** Guard post (owner decision 2026-11-11): a guarding capital fights from its
 *  post. Inside this share of its guard radius it holds station with its beam
 *  to the target; beyond it, it closes on the post. */
export const GUARD_HOLD_FRAC = 0.5;
/** Beyond this share of the guard radius a guarding capital gives up its
 *  broadside heading and turns its axis to the post so thrust can bring it back. */
export const GUARD_RETURN_FRAC = 0.8;
/** Station-keeping: the most a guarding capital steams toward its post, as a
 *  share of the kind's max speed (it must stop again inside the radius). */
export const GUARD_RETURN_SPEED = 0.5;
/** Station-keeping pilot: a capital's thrust is the only brake it has on a
 *  course across its axis, so it may thrust with any nose (no thrust cone). */
export const GUARD_PILOT_PARAMS: Readonly<PilotParams> = { ...DEFAULT_PILOT_PARAMS, thrustConeCos: -1 };
/** Combat flying (dogfight manoeuvres): the afterburner is used hard, as a
 *  player uses it (owner 2026-11-13: "don't forget the afterburner to gain
 *  speed fast"): with the nose within ~37° of the course (not 18°), and as
 *  soon as the wanted speed along the nose beats the actual by 15 % of the
 *  kind's top speed. Whether a manoeuvre wants it is its own call.
 *  Thrust is held by default in combat (owner 2026-11-14: "everyone
 *  accelerates all the time in combat, unless they've got a reason not to"):
 *  speed is managed by turning; the pilot lets go only when the manoeuvre
 *  wants clearly less speed than it has, and each throttle choice stands for
 *  `COMBAT_THROTTLE_HOLD_TICKS` (no on/off chatter). */
export const COMBAT_THROTTLE_HOLD_TICKS = 8;
/** The target's speed as the slow-target call (`targetSlow`) sees it,
 *  smoothed over ~0.75 s (first-order, per combat tick). A Robot Orb dips from ~120 to
 *  10–50 u/s for a moment in every tight turn; read raw, each dip flipped
 *  a tailing fighter to a strafing run and back (take 6: Tail / AttackRun /
 *  Break 0.63 switches a second against an Orb, 0.17–0.32 against a Cube). */
export const TARGET_SPEED_TAU_TICKS = 45;
export const TARGET_SPEED_GAIN = 1 / TARGET_SPEED_TAU_TICKS;
export const COMBAT_PILOT_PARAMS: Readonly<PilotParams> = {
  ...DEFAULT_PILOT_PARAMS, boostConeCos: 0.8, boostSpeedGap: 0.15,
  combatThrust: true, throttleHoldTicks: COMBAT_THROTTLE_HOLD_TICKS,
};
/** A ship running from a pursuer (`ManoeuvreGoal.spendReserve`) boosts with
 *  its nose anywhere within 90° of its course: a weave keeps the nose turning,
 *  and under the combat cone it would hardly ever light the afterburner while
 *  running for its life. The boost still pushes along the nose (mostly away). */
export const RUN_PILOT_PARAMS: Readonly<PilotParams> = { ...COMBAT_PILOT_PARAMS, boostConeCos: 0 };
/** `ManoeuvreGoal.throttleNow`: running, with no throttle hold. */
export const RUN_NOW_PILOT_PARAMS: Readonly<PilotParams> = { ...RUN_PILOT_PARAMS, throttleHoldTicks: 0 };
/** The AI pilot's choice of when to press boost, like a player holding some
 *  back: in combat it keeps this share of the ship's pool in hand, and only a
 *  Break (getting out from under fire) or a run (`spendReserve`) burns below
 *  it. Not a ship or energy rule. 0.25 (2026-11-14): at 0.10 the pilot often
 *  couldn't afford a full Break; with every ship's pool doubled
 *  (`ENERGY_POOL_MUL`) a quarter of the pool is a Break's worth and still
 *  leaves the pilot more boost to open a fight with than before. */
export const BOOST_RESERVE_FRAC = 0.25;
/** Forget a hostile player after this many ticks of no fresh damage from
 *  them. 1800 ticks @ 60 Hz = 30 s. Mirrors the player's own intuition that
 *  if they've been clean for half a minute, the drone has lost interest. */
export const FORGET_TICKS = 1800;
/** Part C — bias the drone's target pick toward the lowest-health hostile
 *  ("gang up on the wounded one") instead of pure nearest. Moderate so a
 *  far-but-wounded player doesn't pull a drone across the sector past a
 *  point-blank threat — distance² still dominates at large gaps. No effect when
 *  the player view carries no health (e.g. older tests). */
export const DRONE_TARGET_HEALTH_WEIGHT = 1.5;
/** Part C — hard switch-DELAY: once a drone commits to a target it holds it for
 *  this many ticks before re-evaluating, so a pack doesn't all flip targets in
 *  unison every tick as ranges cross. ~0.5 s at 60 Hz. Server-only (deterministic
 *  server tick; the client never ticks the drone brain). */
export const DRONE_TARGET_DWELL_TICKS = 30;
/** Wave-system Phase 2 — how strongly a drone in COMBAT favours STRUCTURES over
 *  player ships (req #2 "structures primarily"). Fed to `pickTarget` as
 *  `priorityBias`; structures carry `priority 1`, players `priority 0`, so a
 *  structure's score is divided by `(1 + bias)`. With score ∝ d², a bias of 3
 *  means a structure up to 2× as far as a player still wins the pick. */
export const STRUCTURE_PRIORITY_BIAS = 3;
/** RTS Part B slice 8 — the `priority` an owner's ATTACK ORDER gives its target
 *  inside the same pick (owner rule: priority, never a hard override). With
 *  `STRUCTURE_PRIORITY_BIAS` the target's score is divided by 13: it wins over
 *  a free enemy up to ~3.6× nearer, and stays the pick with two squadmates
 *  already on it (claims ×9); a fourth ship on it spreads to a free enemy at
 *  a comparable distance (spread targets, dwell and stickiness unchanged). */
export const ORDERED_TARGET_PRIORITY = 4;
/** Target orbit radius for IDLE patrol. Players spawn near the origin so
 *  this is comfortably outside the spawn zone without being so far that
 *  drones are off-screen most of the session. */
export const PATROL_RADIUS = 1800;
/** Calm (non-combat) travel speed as a share of the kind's thrust cruise
 *  speed: patrols, squad courses and flock followers fly at it. The pilot
 *  layer (2026-11-13) gave NPCs their full player handling; out of combat they
 *  CHOOSE to cruise slower, at the pace the retired `ai.thrust` (≈0.45× the
 *  player thrust) used to give, so roaming squads keep their readable pace. */
export const CALM_CRUISE_FRAC = 0.45;
/** Ticks a ship that asked to warp out keeps running (the 3 s spool plus
 *  slack; the room removes it when the run starts). Without a room warp it
 *  then holds at the drop point. */
export const LEAVING_RUN_TICKS = 300;
/** Patrol speed as a share of the calm cruise, so the orbit stays slow and
 *  readable and the inward bias wins when a drone spirals back. */
export const PATROL_SPEED_FRAC = 0.5;
/** Strength of the inward bias applied when the drone is outside
 *  `PATROL_RADIUS`. Blends from 0 at the radius to 1 at 2 × radius. */
export const PATROL_INWARD_GAIN = 1.0;
/** Roaming-formation (Phase 5): distance to the assigned move target within
 *  which the drone ramps thrust down so per-kind damping brakes it to a stop
 *  (the "slow down and come to a stop in formation, don't float past" feel). */
export const MOVE_ARRIVE_SLOW_RADIUS = 300;
/** Travel (RTS Part B slice 9, `setTravel`): a leg longer than this many
 *  guard radii (`shipTuning.guardRadiusMin`, #18) flies at the top speed and
 *  may boost (the old wingman's long-leg rule, 3 × its guard radius). */
export const TRAVEL_LONG_LEG_GUARD_MUL = 3;
/** Travel is done inside `shipTuning.wingmanArrive` and slower than this
 *  share of the max speed (nearly stopped; the old wingman's arrival rule). */
export const TRAVEL_ARRIVE_SPEED_FRAC = 0.03;
/** Travel state (`getTravelState`): none, on the way, arrived. */
export const TRAVEL_NONE = 0;
export const TRAVEL_ON_THE_WAY = 1;
export const TRAVEL_ARRIVED = 2;
export type TravelState = typeof TRAVEL_NONE | typeof TRAVEL_ON_THE_WAY | typeof TRAVEL_ARRIVED;
/** Hunt search (RTS Part B slice 6): the expanding-square legs are this many
 *  sighting ranges apart, so each leg's swept band (one sighting range either
 *  side of the track) overlaps the last and nothing is skipped. */
export const HUNT_LEG_SPACING_MUL = 1.5;
/** Hunt search waypoints stay inside this share of the sector half extent. */
export const HUNT_EDGE_FRAC = 0.95;
/** Non-combat herding: a flock LEADER cruises its course at this fraction of the
 *  calm cruise, so its FOLLOWERS — moving at the full calm cruise
 *  — actually outrun it and tighten into the herd. Without the throttle the
 *  leader and followers share the same slow max-speed and the herd can never
 *  close the gap (the boost the old scheme used to paper over this is gone; the
 *  user's "make the leader wait" instead). ~0.55 = leader noticeably slower than
 *  the flock but still genuinely travelling. The director ALSO holds the leader
 *  outright when the squad is badly spread (course = its own pose). */
export const LEADER_CRUISE_THROTTLE = 0.55;
/** A follower within this many follow distances of its leader reads as
 *  "guarding" on the owner's panel, else "moving" (forming up). */
export const FLOCK_ACTIVITY_GAP_MUL = 2;
/** A follower of a leader faster than the calm cruise flies this multiple of
 *  the leader's speed (capped at its top speed) so the pack closes up. */
export const FLOCK_CATCH_UP = 1.25;

// ── Combat context steering (AI steering plan slice 2c) ─────────────────
/** Neighbours read per combat tick (nearest first). */
export const COMBAT_NEIGHBOUR_K = 8;
/** Query reach, × `combatSeparation`: danger fades out by here. */
export const COMBAT_SEP_REACH = 1.25;
/** Full-strength neighbour danger inside this fraction of `combatSeparation`. */
export const COMBAT_SEP_CORE = 0.5;
/** Speed a crowded ship drifts apart at, × cruise, at full crowding. */
export const COMBAT_CROWD_SPEED = 0.6;
/** Blocked-fire nudge: done once within this share of `combatSeparation`
 *  of its reposition point; interest lobe sharpness. */
export const NUDGE_ARRIVED = 0.2;
export const NUDGE_SHAPE = 2;
/** Out of fire range, facing switches to the move heading when the move is
 *  this far off the GOAL heading (radians; 100°), and back below
 *  `FACE_MOVE_EXIT` (80°): a detour forced by wingmen. */
export const FACE_MOVE_ENTER = (100 * Math.PI) / 180;
export const FACE_MOVE_EXIT = (80 * Math.PI) / 180;
/** Below this wanted speed (× cruise) the nose stays on the lead point:
 *  the pilot's reverse handles a slow back-off without turning away. */
export const FACE_MOVE_MIN_SPEED = 0.25;
/**
 * Hull avoidance (ramming is a real weapon since #558, so an accidental ram
 * hurts both ships). Any ship whose closest approach on the current
 * velocities passes inside `hullClearance` (both shield bubbles + a radius), sooner
 * than the time I need to turn the nose sideways at my turn rate and slide
 * clear with my thrust (× `AVOID_SAFETY`, + `AVOID_LATENCY_S`), makes me
 * dodge: nose to the side away from it, thrust and boost. All from the
 * kind's own handling and size, so it follows a retuned ship.
 */
export const AVOID_SAFETY = 1.3;
export const AVOID_LATENCY_S = 0.1;
/** Look this many seconds of closing ahead for a ship to avoid. */
export const AVOID_LOOK_S = 3;
/** The dodge side (left / right of the closing velocity) is latched for the
 *  running manoeuvre, and freed once no dodge has been flown for this long
 *  (ticks, 1 s). Picked afresh each tick, it flipped as the two ships slid
 *  across each other's closest-approach point: the turn key flapped at full
 *  rate nose to nose (filmed Robot Orb, 2026-11-14). */
export const AVOID_SIDE_IDLE_TICKS = 60;
/** Simulation ticks per second (fixed 60 Hz step). */
export const TICKS_PER_S_SIM = 60;

// ── Decision layer (AI overhaul slice 4) ────────────────────────────────
/** Recent-hit counter half-life (ticks): the "under heavy fire" signal. */
export const HIT_HALF_LIFE_TICKS = 60;
/** Ally / enemy counts read at decision time within this × fire range. */
export const COUNT_RANGE_MUL = 1.5;
/** A fleeing ship warps out this many × its sensor range along its escape
 *  heading (well clear of the fight it ran from; #18: sensor range follows
 *  the ship's fire range). */
export const WARP_OUT_SENSOR_MUL = 4;
/** A FallBack on its way runs at least `MORALE_LOCK_TICKS`, and on until it
 *  reaches its friends, but never longer than this (15 s). Once among them
 *  (or with none to reach) it re-engages at once. */
export const FALLBACK_MAX_TICKS = 3 * MORALE_LOCK_TICKS;

/** The morale die (test seam: `setMoraleRoll`). */
export type MoraleRollFn = (inputs: MoraleInputs, base: MoraleWeights, seed: number) => MoraleOutcome;

/** Phase 1 state machine: drones either patrol idle (orbit origin) or
 *  pursue & shoot a hostile player. Future phases may add more states
 *  (FLEE, REGROUP, etc.) — the structure is intentionally minimal here. */
export type DroneState = 'IDLE' | 'COMBAT';

/** A ship's one energy pool as the AI pilot reads and spends it (boost and
 *  guns). Structural, so a hull's own record (`ShipState`, `energy` field)
 *  can be handed in as is. */
export interface ShipEnergyPool {
  energy: number;
}

/**
 * Construction options for an AI pilot brain. All absent ⇒ a drone-side brain,
 * byte-identical to one built from the kind alone.
 */
export interface HostileDroneBehaviourOptions {
  /** Fly for the players side instead of the kind's NPC allegiance (an RTS
   *  owned ship): target claims and neighbour grouping use the players side;
   *  every pilot is friendly; anything that attacks players on sight is an
   *  enemy; the ship never runs (morale always Fight on). */
  readonly side?: typeof PLAYERS_SIDE;
  /** The player who owns this ship: its own fire never turns the brain on it. */
  readonly ownerId?: string;
  /** The ship's one energy pool. Absent ⇒ a pool of its own, full at the
   *  kind's `energyMax`. Either way the brain reads and spends it the same. */
  readonly energyPool?: ShipEnergyPool;
}

/** Morale weights of a ship that never runs: every roll is Fight on. */
export const NEVER_RUN_MORALE = Object.freeze({ fightOn: 1, fallBack: 0, flee: 0 });
