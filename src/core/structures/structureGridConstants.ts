/**
 * Power-grid + construction constants (speed-dial-resource-structures plan).
 *
 * Zone-pure: shared by the server grid subsystem and any client-side preview
 * math. Values mirror eqx-peri's `GridManager` + The Space Game (see the plan's
 * "Logistics mechanics reference" table); tune for eqx-net world scale.
 *
 * Phase 2 introduces `SCAFFOLDING_HP_FRACTION` (a freshly-placed blueprint
 * spawns at this fraction of `maxHealth`, non-operational). Phase 3 appends the
 * connection / pulse / construction-rate constants here.
 */

/** A just-placed blueprint spawns at this fraction of `maxHealth` and is
 *  non-operational (power/storage/mining/fire all gated behind `isConstructed`)
 *  until the grid pulse finishes building it. */
export const SCAFFOLDING_HP_FRACTION = 0.1;

// ── Connections (Phase 3) ──────────────────────────────────────────────────

/** Max edge-to-edge (AABB) distance for a connection, world units. Beyond this
 *  two structures can't link — the player bridges the gap with a Connector. */
export const CONNECTION_MAX_RANGE = 600;

/** Per-connection units/pulse cap on material flow (Phase 4 hauling). Large by
 *  default — the throughput ceiling rarely bites with one mineral type. */
export const CONNECTION_THROUGHPUT = 100_000;

// ── Pulse (Phase 3) ────────────────────────────────────────────────────────

/** The grid heartbeat period, ms. One 1 Hz pulse drives power aggregation,
 *  construction, repair, deconstruction, and (Phase 4) mineral hauling. Runs
 *  OFF the 60 Hz physics tick (LivingWorldDirector pattern, `unref`'d). */
export const TRANSFER_PULSE_MS = 1000;

/** How long a connection stays lit after carrying flow, ms (client visual). */
export const FLASH_DURATION_MS = 300;

// ── Construction / repair / deconstruction flow economy (Phase 3) ──────────

/** Minerals delivered to ONE blueprint per pulse (drained from connected
 *  storage). Construction pauses automatically when the source runs dry. */
export const CONSTRUCTION_PULSE_AMOUNT = 5;

/** Minerals spent repairing ONE damaged built structure per pulse. */
export const REPAIR_PULSE_AMOUNT = 3;

/** Minerals consumed per hull point repaired. */
export const REPAIR_COST_PER_HP = 0.1;

/** Minerals reclaimed per pulse while a structure is being deconstructed. */
export const DECONSTRUCTION_RATE_KG = 100;

/** Minerals the pre-built Capital starts with, so a base can bootstrap a few
 *  Connectors + Solar panels before mining (Phase 4) comes online. */
export const CAPITAL_STARTING_MINERALS = 5000;

/** Turret aim/fire tick interval, ms (Phase 5). Faster than the 1 Hz grid pulse
 *  so turrets track + engage drones responsively; actual shots are gated by the
 *  per-kind `fireRateMs`. */
export const TURRET_TICK_MS = 100;

/** WS-4 — mining-beam re-broadcast interval, ms. The Miner's beam is a
 *  CONTINUOUS visual, so it must refresh faster than the client's ~400 ms
 *  laser_fired TTL or it would flicker; 200 ms (5 Hz) keeps it solid with
 *  headroom while halving the wire vs the 100 ms turret tick. Ticked from the
 *  same `structureTurretTick` timer, gated per-Miner by `lastMiningBeamMs`. */
export const MINING_BEAM_CADENCE_MS = 200;
