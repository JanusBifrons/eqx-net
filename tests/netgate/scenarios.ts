/**
 * Netgate scenario catalogue — the SINGLE SOURCE OF TRUTH for the
 * multi-scenario netcode-health gate (plan: misty-teapot).
 *
 * Read by BOTH:
 *   - `tests/e2e/netcode-health.spec.ts` — generates one `test()` per
 *     selected scenario, parameterised by the descriptor below.
 *   - `tests/netgate/select-scenarios.mjs` — maps a PR's changed files to
 *     the set of scenarios CI must run (`triggerGlobs`), so a structures-
 *     only PR doesn't pay for the scrap scenario and vice-versa.
 *
 * No room name or trigger glob is duplicated between the spec and the
 * workflow YAML — they both resolve through this module.
 *
 * IMPORTANT — what the netgate can and cannot gate (hostile review,
 * 2026-06-15): every gated metric in `netHealthBudget.ts` measures the
 * LOCAL PLAYER's prediction reconciliation. It CANNOT detect a
 * structures/scrap CORRECTNESS regression (wrong `componentIndex`, broken
 * `structures[]` encode) — those move no local-player metric, and the
 * lossless in-order proxy never drops a late/bloated payload. Correctness
 * is gated DETERMINISTICALLY (`scrapOnDeath.test.ts`,
 * `structureScenario.test.ts`). The new scenarios instead gate
 * structures/scrap PERFORMANCE under load — code that is correct but blows
 * the server tick/broadcast budget degrades the local player's feel — and
 * they stay `print-only` until a SERVER-SIDE tick-burn fault-injection
 * self-test proves their metrics actually move (principle #3 in the plan).
 */
import type { GatedMetric, MetricBudget } from './netHealthBudget';

/** Keyed interaction the spec drives for a scenario. Only one today. */
export type InteractionId = 'strafe-fire';

export interface NetgateScenario {
  /** Stable id — the NETGATE_SCENARIOS CSV token, the CI selection key,
   *  and the per-scenario Playwright test title. */
  name: string;
  /** Colyseus room to join — ALSO the `/dev/reset-sector?key=` value. */
  room: string;
  /** Extra query appended after `?room=<room>&diag=0`. Leading '&' or ''. */
  urlParams: string;
  /** `data-testid` the spec polls for readiness (parses `Ships: N` > 0). */
  liveSelector: string;
  /** Which fixed, deterministic input sequence the spec runs. */
  interaction: InteractionId;
  /** Default interleaved A/B reps. `NETGATE_REPS` env OVERRIDES this
   *  (core's CI reps stay 8 — its budget margins are calibrated at 8). */
  reps: number;
  /** 'gate' — a budget breach FAILS CI. 'print-only' — run + log the
   *  verdict, assert only liveness, never gate the budget (used until a
   *  scenario's regression power is proven; see module header). */
  gating: 'gate' | 'print-only';
  /** Per-scenario relative/absolute margin overrides merged over
   *  NET_HEALTH_BUDGET (cannot add/remove gated metrics — set is locked). */
  budgetOverride?: Partial<Record<GatedMetric, MetricBudget>>;
  /** Regex sources (tested against changed file paths, `/` separators)
   *  that should trigger this scenario in CI. */
  triggerGlobs: string[];
}

/**
 * Shared live-loop paths — a change here can move ANY scenario's local
 * feel, so it triggers every gated scenario. Mirrors the historical
 * `netgate.yml` `changes`-job regex (the single source of truth now lives
 * here, not in YAML).
 */
export const SHARED_LIVELOOP_GLOBS: readonly string[] = [
  '^src/client/net/',
  '^src/client/render/',
  '^src/core/prediction/',
  '^src/core/physics/',
  '^src/core/ai/WeaponMountController\\.ts$',
  '^src/server/rooms/SectorRoom\\.ts$',
  '^src/server/rooms/SnapshotBroadcaster\\.ts$',
  '^src/server/rooms/EntitySyncRouter\\.ts$',
  '^src/server/net/',
  '^src/shared-types/swarmWireFormat\\.ts$',
  '^src/shared-types/messages/',
  '^tests/netgate/',
  '^tests/e2e/netcode-health\\.spec\\.ts$',
];

/**
 * Structure server/core/wire paths. The grid pulse + turret tick + the
 * `structures[]` snapshot slice + `grid_pulse` are live-loop (the repo
 * docs already declare them netgate-required, invariant #8) — yet the
 * HISTORICAL netgate path filter omitted them, so a pure structures
 * change SKIPPED the gate. Folding these into `core.triggerGlobs` closes
 * that false-negative hole: a structures change now runs `core` (the
 * foundational local-feel regression check). When a `structures-load`
 * scenario is promoted to gated (P3), it maps to these specifically.
 */
export const STRUCTURE_GLOBS: readonly string[] = [
  '^src/server/structures/',
  '^src/core/structures/',
  '^src/shared-types/structureKinds\\.ts$',
];

/**
 * Scrap server/core paths. Composite-death scrap rides the binary swarm
 * wire (v4 `componentIndex`); `swarmWireFormat.ts` + the client decoder
 * (`src/client/net/`) are already in SHARED, so these add the spawn +
 * collider + constants the historical filter omitted.
 */
export const SCRAP_GLOBS: readonly string[] = [
  '^src/server/spawn/ScrapSpawner\\.ts$',
  '^src/core/geometry/scrapCollider\\.ts$',
  '^src/core/swarm/scrapConstants\\.ts$',
];

/**
 * The scenario catalogue. P0 ships only `core` (byte-identical to the
 * historical single-scenario gate). P3 appends `structures-load` and
 * `scrap-load` (print-only). P2 widens `core.triggerGlobs` to ALSO fire
 * on structure/scrap server paths (closing the path-filter hole the repo
 * docs already declare netgate-required).
 */
export const SCENARIOS: readonly NetgateScenario[] = [
  {
    name: 'core',
    room: 'feel-test-25',
    urlParams: '',
    liveSelector: '[data-testid="ship-count"]',
    interaction: 'strafe-fire',
    reps: 8,
    gating: 'gate',
    // SHARED ∪ STRUCTURE ∪ SCRAP — core is the catch-all local-feel gate,
    // so a structures/scrap change fires it (closing the path-filter hole).
    triggerGlobs: [...SHARED_LIVELOOP_GLOBS, ...STRUCTURE_GLOBS, ...SCRAP_GLOBS],
  },
];

/** Resolve a CSV of scenario names to descriptors, preserving catalogue
 *  order and erroring loudly on an unknown name (a typo must fail, not
 *  silently skip — that would be a fail-OPEN gate). */
export function resolveScenarios(csv: string): NetgateScenario[] {
  const names = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const wanted = new Set(names.length > 0 ? names : ['core']);
  const known = new Set(SCENARIOS.map((s) => s.name));
  for (const n of wanted) {
    if (!known.has(n)) {
      throw new Error(
        `[netgate] unknown scenario '${n}' in NETGATE_SCENARIOS — known: ${[...known].join(', ')}`,
      );
    }
  }
  return SCENARIOS.filter((s) => wanted.has(s.name));
}
