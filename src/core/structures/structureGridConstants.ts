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
 *  two structures can't link — the player bridges the gap with a Connector.
 *  The UNIFORM range for EVERY kind (P3.2 — "everything has the same range
 *  connectors"). `GridNode.connectionRange` remains an optional per-kind
 *  override seam for the future, but no kind sets it today, so `canConnect`'s
 *  `min`-of-endpoints collapses to this for every pair. */
export const CONNECTION_MAX_RANGE = 600;

/** The cable art's body width at 1x, world units (the client cable look,
 *  `connectorLineLooks.ts`, draws with this). Each end collar sits half of it
 *  in from its stud. Also the clearance two cables keep from each other:
 *  centrelines closer than one body width draw on top of each other. */
export const CABLE_BODY_WIDTH = 12;

/** The cable art's station pitch at 1x, world units: one section of bundle
 *  between two stations (collar, lashing, cradle, lashing, ...). The client
 *  cable look lays its stations out at this pitch. */
export const CABLE_STATION_PITCH = 55;

/** Shortest cable, as the gap between the two footprint boxes it joins, EDGE
 *  to edge (`edgeDistance`), world units. Closer than this a link is refused
 *  (`'too-short'`, owner rule "keep buildings apart"): the player always sees
 *  at least one clear section of cable between the two buildings. From the
 *  cable art: two end collars (half a body width each) plus one station
 *  pitch of bundle, 6 + 55 + 6 = 67. Studs sit on the footprint, so the
 *  cable itself is never shorter. Fence links (post to post) are exempt. */
export const MIN_CABLE_LENGTH = CABLE_BODY_WIDTH + CABLE_STATION_PITCH;

/** WS-5 (R2.17) — the global cap on how many hubs a single freshly-placed
 *  structure auto-connects to on placement. A structure's OWN `maxConnections`
 *  (Connector 6, Capital 4, leaves 1) already bounds it; this is the additional
 *  safety ceiling so a future high-cap hub can't fan out unboundedly at placement
 *  time. 6 = the Connector cap, so today it coincides with the own-cap for every
 *  kind (no kind exceeds 6). Open Decision 4 chose a global `core` constant over
 *  a per-kind catalogue field (no second catalogue-version bump in PR 2). */
export const PLACEMENT_MAX_CONNECTIONS = 6;

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

/** Campaign 4.3 (review A8) — the smallest repair that LANDS (and flashes the
 *  route). A deficit below this accumulates silently, so a structure under
 *  sustained sub-quantum chip damage repairs in visible bursts (the route
 *  reads idle between) instead of strobing the green line every 1 Hz pulse
 *  forever. Also kills the float-dust re-flash (hp a rounding-sliver below
 *  max). Feel knob — tune on-device. */
export const REPAIR_MIN_HP_QUANTUM = 1;

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
