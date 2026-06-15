/**
 * Netgate scenario selector (plan: misty-teapot) — maps a PR's changed
 * files to the CSV of netgate scenarios CI must run.
 *
 * Plain Node ESM by design: the `.github/workflows/netgate.yml` `changes`
 * job runs it with bare `node` (no pnpm install, no tsx) so the path
 * filter stays cheap. It therefore cannot import the TypeScript
 * `scenarios.ts`; the gated-scenario glob table is MIRRORED here and the
 * mirror is locked against `scenarios.ts` by `scenarios.test.ts` (a drift
 * fails the unit suite).
 *
 * FAIL-CLOSED / default-DENY (hostile review M3): the historical workflow
 * is fail-closed — a skipped gate must never read as healthy unless the
 * filter PROVED the diff is non-live-loop. So:
 *   - empty / unreadable changed-file list (incl. a GitHub-API 3000-file
 *     truncation) ⇒ run ALL gated scenarios;
 *   - a changed file under a live-loop area that matched no specific
 *     scenario glob ⇒ run ALL gated scenarios;
 *   - ONLY a provably non-live-loop diff (docs, diag, unrelated dirs) ⇒
 *     empty (the gate legitimately skips).
 *
 * Usage:
 *   node tests/netgate/select-scenarios.mjs <file> <file> ...   # args, or
 *   printf 'a.ts\nb.ts\n' | node tests/netgate/select-scenarios.mjs  # stdin
 * Prints a CSV (possibly empty) of gated scenario names to stdout.
 */
import process from 'node:process';

/**
 * GATED scenarios → their trigger globs (regex sources over '/'-separated
 * repo-relative paths). MUST mirror the `gating:'gate'` entries of
 * SCENARIOS in scenarios.ts (locked by scenarios.test.ts). Print-only
 * scenarios are intentionally absent — they never run per-PR.
 */
export const GATED_SCENARIO_GLOBS = {
  core: [
    // SHARED_LIVELOOP_GLOBS
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
    // STRUCTURE_GLOBS
    '^src/server/structures/',
    '^src/core/structures/',
    '^src/shared-types/structureKinds\\.ts$',
    // SCRAP_GLOBS
    '^src/server/spawn/ScrapSpawner\\.ts$',
    '^src/core/geometry/scrapCollider\\.ts$',
    '^src/core/swarm/scrapConstants\\.ts$',
  ],
};

/**
 * Directory-level "could plausibly affect the live loop" areas — the
 * fail-closed safety net for a NEW file in a hot dir that no specific
 * scenario glob enumerates yet. Broader than the specific globs at the
 * directory level, but NOT "all of src/server" (auth/db/routes/galaxy-HTTP
 * can't move the local-feel metrics, so they stay lean).
 */
export const LIVELOOP_PREFIXES = [
  '^src/server/rooms/',
  '^src/server/structures/',
  '^src/server/spawn/',
  '^src/server/net/',
  '^src/core/prediction/',
  '^src/core/physics/',
  '^src/core/ai/',
  '^src/core/combat/',
  '^src/core/structures/',
  '^src/core/swarm/',
  '^src/core/geometry/',
  '^src/client/net/',
  '^src/client/render/',
  '^src/shared-types/',
  '^tests/netgate/',
  '^tests/e2e/netcode-health\\.spec\\.ts$',
];

const ALL_GATED = Object.keys(GATED_SCENARIO_GLOBS);

function matchesAny(file, globs) {
  return globs.some((g) => new RegExp(g).test(file));
}

/**
 * @param {string[]} changedFiles repo-relative paths (any separator).
 * @returns {string[]} gated scenario names to run (catalogue order).
 */
export function selectScenarios(changedFiles) {
  // Fail-closed: no usable file list ⇒ run everything gated.
  if (!Array.isArray(changedFiles)) return [...ALL_GATED];
  const files = changedFiles
    .map((f) => String(f).replace(/\\/g, '/').trim())
    .filter((f) => f.length > 0);
  if (files.length === 0) return [...ALL_GATED];

  // 1. Specific routing: which gated scenarios' globs are hit.
  const selected = ALL_GATED.filter((name) =>
    files.some((f) => matchesAny(f, GATED_SCENARIO_GLOBS[name])),
  );
  if (selected.length > 0) return selected;

  // 2. Default-deny: a live-loop-area touch that matched no specific glob
  //    (e.g. a brand-new broadcaster file) ⇒ run ALL gated.
  if (files.some((f) => matchesAny(f, LIVELOOP_PREFIXES))) return [...ALL_GATED];

  // 3. Provably non-live-loop ⇒ legitimately empty.
  return [];
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

// CLI entry — run only when invoked directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('select-scenarios.mjs');
if (invokedDirectly) {
  void (async () => {
    const argFiles = process.argv.slice(2);
    const files = argFiles.length > 0 ? argFiles : (await readStdin()).split(/\r?\n/);
    process.stdout.write(selectScenarios(files).join(','));
  })();
}
