/**
 * Structure grid state (structures plan, Phase 3). Mirrored from
 * `SnapshotMessage.structures[]`, keyed by the same entityId as `swarm` (which
 * holds the pose). Drives the connector web, the scaffolding fill + dim, and the
 * HUD power readout. Pure UI state — no spatial fields (those live in `swarm`).
 */
/** Mine Layer — one proximity mine (from room state `mines`). Static. */
export interface MineRenderState {
  x: number;
  y: number;
  /** Laid by the local player's base (drawn friendly). */
  own: boolean;
  /** Sync generation (sweep stamp; renderer ignores it). */
  gen: number;
}

export interface StructureRenderState {
  /** Phase-4 C3 — hull health fraction [0..1], decoded from the slice's 0-100
   *  `hpPct`. Lets the inspector render the hull bar instantly on selection
   *  (no `entity_stats` round-trip). Absent ⇒ unknown (panel falls back to the
   *  server stats packet). */
  hpPct?: number;
  /** Component net power ≥ 0 AND reachable to a Capital. */
  powered: boolean;
  /** Component net power (Σ output − Σ consumption over built members). */
  netPower: number;
  /** Connected neighbour entityIds — the web edges. */
  connTo: number[];
  /** True once fully constructed (blueprints render dimmed until then). */
  built: boolean;
  /** Construction fraction [0..1] (1 when built) — drives the fill-bar. */
  buildPct: number;
  /** Estimated ms to completion at the steady rate while building (issue 1/2);
   *  `null` ⇒ stalled (no minerals) → freeze the bar + show a paused timer;
   *  `undefined` ⇒ built / not applicable. Drives the smooth linear build bar
   *  and the in-world ETA countdown. */
  etaMs?: number | null;
  /** Deconstruction fraction [0..1] while reclaiming (0 normally). */
  deconstructPct: number;
  /** True while the owner is reclaiming this structure (issue 6) — drives the
   *  inspector's Deconstruct↔Cancel button + the drain bar. */
  isDeconstructing?: boolean;
  /** Phase 4 — asteroid entityId a Miner is extracting from (draws the beam),
   *  or undefined. */
  miningTargetId?: number;
  /** Phase 5 — drone entityId a Turret is aiming at (draws the aim line), or
   *  undefined. */
  turretTargetId?: number;
  /** Coastal defences — the server's turret angles for a defence structure
   *  (arc-local radians, catalogue order), or undefined while they rest. The
   *  drawn barrels ease toward these (the server is the only writer, #12). */
  mountAngles?: number[];
  /** B2 — playerId a Turret is aiming at (an NPC turret engaging a hostile
   *  pilot), or undefined. Mutually exclusive with `turretTargetId`. */
  turretTargetPlayerId?: string;
  /** Batteries plan — current stored power (Battery only; undefined elsewhere). */
  storedPower?: number;
  /** Batteries plan — the Battery's stored-power capacity (readout denominator). */
  storedPowerMax?: number;
  /** WS-9 (R2.12) — minerals stored at this structure (the Capital's bank). Drives
   *  the world-space capital resource readout. Undefined ⇒ not surfaced. */
  minerals?: number;
  /** Shield-fence plan — the paired pylon's entityId this Shield Pylon projects
   *  a wall span to (undefined when unpaired). Joined to `mirror.swarm` for the
   *  pair's pose to draw + predict the span. */
  shieldWallTo?: number;
  /** A shield emitter's walls are up (all powered, none stunned). Walls are
   *  derived from `connTo` between emitters, plus each gate's own spans. */
  wallActive?: boolean;
  /** Gates: open bits (GATE_OPEN_A = span 0, GATE_OPEN_B = span 1). */
  gateOpen?: number;
  /** Gates: access setting (GATE_ACCESS_IDS index; undefined ⇒ default). */
  gateAccess?: number;
  /** Production (P2b): the selected recipe byte (0/absent = default), the
   *  PROD_STATE, and the good a starved processor waits for (index + 1). */
  recipe?: number;
  prodState?: number;
  prodMissing?: number;
  /** P2d — an ammo-using turret has no munitions. */
  noAmmo?: boolean;
  /** D1 — a Reactor has no fuel (no power). */
  noFuel?: boolean;
  /** Active power — drawing full consumption (else the idle trickle). */
  drawFull?: boolean;
  /** C2 — someone is breaking into its cargo right now. */
  breach?: boolean;
  /** The slot blueprint (P2b): runs (BP_RUNS_ORIGINAL = original) + quality. */
  bpRuns?: number;
  bpQuality?: number;
  /** v4 T1 — a teleporter: present only for teleporter kinds. */
  teleport?: {
    phase: number;
    phaseMs: number;
    chargePct: number;
    /** Partner entityId; -1 none; -2 in another sector. */
    partner: number;
    rules: number;
    loadGood: number;
    loadQty: number;
    keepGood: number;
    keepQty: number;
    padWeight: number;
    /** T4 — toll, credits per 1000 charge (0 = free). */
    toll: number;
  };
  /** Owning playerId. Drives the inspector's "is this mine?" check AND the
   *  same-owner filter on connection / placement-preview lines — a cross-owner
   *  structure is visible but never draws a connection line to the local grid. */
  owner?: string;
  /** The owner's resolved DISPLAY NAME (server-side). Shown in the inspector;
   *  absent ⇒ orphaned owner (server-logged) → the inspector shows "Unknown". */
  ownerName?: string;
  /** Phase 4 (Leveling & XP, WS-0) — structure level (≥ 1). Read path for the
   *  inspector's `LVL n` line + the Upgrade affordance (the build phase + the
   *  wire field are owned by WS-B4). Absent ⇒ level 1. Discrete scalar —
   *  purity-clean (Invariant #2). */
  level?: number;
}
