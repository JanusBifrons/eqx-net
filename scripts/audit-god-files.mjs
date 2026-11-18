#!/usr/bin/env node
/**
 * audit-god-files.mjs — file-size enforcement: god files + CLAUDE.md budgets.
 *
 *   `--claude-md` checks only the CLAUDE.md byte budgets (CLAUDE_MD_BUDGETS;
 *   run by the CI `verify` job on every PR). The CLAUDE.md files are injected
 *   into every agent context; they hold rules only (root CLAUDE.md
 *   "What goes where").
 *
 * Two layers of protection:
 *
 *   1. Ceiling — any `src/**` file > 600 LOC that is NOT in the
 *      allowlist fails CI. The allowlist starts at the post-merge
 *      god-file roster (SectorRoom, ColyseusClient, PixiRenderer,
 *      App.tsx); a new file > 600 LOC must either split itself OR
 *      add an entry with a justification.
 *
 *   2. Ratchet — each allowlist entry declares a `cap` (current LOC,
 *      with a small +slack). A file may shrink under its cap; growth
 *      past `cap` fails CI. As the v3 refactor lands extractions, the
 *      committer tightens caps so backsliding is impossible.
 *
 * Each entry also has an informational `target` (the file's design-time
 * LOC after the v3 refactor lands) so reviewers see how far is left.
 *
 * Usage:
 *   node scripts/audit-god-files.mjs           # fail on violation
 *   node scripts/audit-god-files.mjs --report  # ranking, no exit
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SRC_DIR = join(REPO_ROOT, 'src');

const CEILING_LOC = 600;
const CAP_SLACK = 10; // tolerate a small in-flight delta during a session

/** Files already over the ceiling when the ratchet went into CI (token-waste review 2026-11-14 section 7, C3). */
const RATCHET_ONLY =
  'over the 600-LOC ceiling when the ratchet went into CI; may only shrink (lower the cap when it does)';

/**
 * Allowlist for the v3 god-file refactor. Each entry must include:
 *   - `cap`:    current LOC + small slack. File may not grow past this.
 *   - `target`: LOC the file should land at when the v3 plan completes.
 *   - `reason`: the plan commit(s) responsible for the planned reduction.
 *
 * As extractions land, REDUCE `cap` so a future commit cannot regress.
 * Path keys are repo-root-relative, POSIX-style (forward slashes).
 */
const ALLOWLIST = {
  'src/client/app/gameRafLoop.ts': { cap: 710, target: 600, reason: 'RTS command layer (#677) grew it past the ceiling; split is a tracked follow-up (.resume/rts-command.md). May only shrink.' },
  'src/client/state/store.ts': { cap: 617, target: 600, reason: 'RTS command layer (#677) grew it past the ceiling; split is a tracked follow-up (.resume/rts-command.md). May only shrink.' },
  'src/server/fleet/FleetCommandSubsystem.ts': { cap: 909, target: 600, reason: 'RTS command layer (#677) grew it past the ceiling; split is a tracked follow-up (.resume/rts-command.md). May only shrink.' },
  'src/server/transit/TransitOrchestrator.ts': { cap: 909, target: 600, reason: 'RTS command layer (#677) grew it past the ceiling; split is a tracked follow-up (.resume/rts-command.md). May only shrink.' },
  'src/client/App.tsx': { cap: 1215, target: 600, reason: RATCHET_ONLY },
  'src/client/__art-lab__/fx.ts': { cap: 979, target: 600, reason: RATCHET_ONLY },
  'src/client/__art-lab__/main.ts': { cap: 702, target: 600, reason: RATCHET_ONLY },
  'src/client/components/EntityStatsPanel.tsx': { cap: 893, target: 600, reason: RATCHET_ONLY },
  'src/client/net/ColyseusClient.ts': {
    cap: 7354,
    target: 350,
    reason:
      'v3 plan commits 16-19 split this into 15 collaborators (PredictionStateManager, ' +
      'SnapshotApplier, MirrorUpdater, etc.); orchestrator target ~350 LOC.',
  },
  'src/client/render/HaloRadar.ts': { cap: 662, target: 600, reason: RATCHET_ONLY },
  'src/client/render/MountVisualManager.ts': { cap: 932, target: 600, reason: RATCHET_ONLY },
  'src/client/render/PixiRenderer.ts': {
    cap: 3964,
    target: 340,
    reason:
      'v3 plan commits 10-14 split this into 15 collaborators (PixiAppLifecycle, ' +
      'CameraController, SpriteFactory, SpriteRegistry, ShipSpriteUpdater, etc.); ' +
      'orchestrator target ~340 LOC.',
  },
  'src/client/render/art/ArtService.ts': { cap: 757, target: 600, reason: RATCHET_ONLY },
  'src/client/render/art/fields.ts': { cap: 1161, target: 600, reason: RATCHET_ONLY },
  'src/client/render/art/fx/fxTextures.ts': { cap: 783, target: 600, reason: RATCHET_ONLY },
  'src/client/render/galaxy/GalaxyMapLayer.ts': { cap: 1044, target: 600, reason: RATCHET_ONLY },
  'src/client/render/pixi/ConnectorRenderer.ts': { cap: 958, target: 600, reason: RATCHET_ONLY },
  'src/client/render/pixi/structureVisuals.ts': { cap: 739, target: 600, reason: RATCHET_ONLY },
  'src/client/render/pixi/wreckArt.ts': { cap: 1925, target: 600, reason: RATCHET_ONLY },
  'src/client/render/worker/Camera.ts': { cap: 871, target: 600, reason: RATCHET_ONLY },
  'src/client/render/worker/WorkerRendererClient.ts': {
    cap: 904,
    target: 600,
    reason: RATCHET_ONLY,
  },
  'src/client/state/storeTypes.ts': { cap: 686, target: 600, reason: RATCHET_ONLY },
  'src/core/ai/HostileDroneBehaviour.ts': { cap: 2880, target: 600, reason: RATCHET_ONLY },
  'src/core/ai/tactics/manoeuvres.ts': { cap: 679, target: 600, reason: RATCHET_ONLY },
  'src/core/bases/growBase.ts': { cap: 740, target: 600, reason: RATCHET_ONLY },
  'src/core/contracts/IRenderer.ts': { cap: 1298, target: 600, reason: RATCHET_ONLY },
  'src/core/destruction/fractureHull.ts': { cap: 1610, target: 600, reason: RATCHET_ONLY },
  'src/core/physics/World.ts': { cap: 1263, target: 600, reason: RATCHET_ONLY },
  'src/core/physics/worker.ts': { cap: 792, target: 600, reason: RATCHET_ONLY },
  'src/server/cargo/StorageService.ts': { cap: 901, target: 600, reason: RATCHET_ONLY },
  'src/server/economy/ConvoyDirector.ts': { cap: 605, target: 600, reason: RATCHET_ONLY },
  'src/server/economy/TradeDirector.ts': { cap: 891, target: 600, reason: RATCHET_ONLY },
  'src/server/index.ts': { cap: 1699, target: 600, reason: RATCHET_ONLY },
  'src/server/livingworld/LivingWorldDirector.ts': { cap: 1575, target: 600, reason: RATCHET_ONLY },
  'src/server/rooms/LockSubsystem.ts': { cap: 684, target: 600, reason: RATCHET_ONLY },
  'src/server/rooms/MissileSimulation.ts': { cap: 946, target: 600, reason: RATCHET_ONLY },
  'src/server/rooms/PlayerFireResolver.ts': { cap: 766, target: 600, reason: RATCHET_ONLY },
  'src/server/rooms/SectorRoom.ts': {
    cap: 10741,
    target: 450,
    reason:
      'v3 plan commits 20-23 split this into 17 collaborators (PhysicsWorkerProxy, ' +
      'PlayerSlotMap, SwarmRegistry, CombatResolver, LagCompRing, WeaponMountTicker, ' +
      'BroadcastScheduler, etc.); orchestrator target ~450 LOC.',
  },
  'src/server/rooms/SnapshotBroadcaster.ts': { cap: 1307, target: 600, reason: RATCHET_ONLY },
  'src/server/rooms/WeaponMountTicker.ts': { cap: 952, target: 600, reason: RATCHET_ONLY },
  'src/server/structures/StructureGridSubsystem.ts': {
    cap: 1119,
    target: 600,
    reason: RATCHET_ONLY,
  },
  'src/shared-types/structureKinds.ts': { cap: 1447, target: 600, reason: RATCHET_ONLY },
};

/**
 * Byte budgets for the auto-injected instruction files (repo-root-relative),
 * measured with LF line endings. Set from the sizes after the second CLAUDE.md
 * diet pass (2026-11-15) plus ~5% headroom. Lower a budget when a file shrinks;
 * never raise one to fit new text: move detail to a docs/ guide instead.
 */
const CLAUDE_MD_BUDGETS = {
  'CLAUDE.md': 16000,
  'src/server/CLAUDE.md': 23900,
  'src/client/CLAUDE.md': 26000,
  'src/core/CLAUDE.md': 15200,
  'plans/CLAUDE.md': 2000,
  // Folder rules next to each god file: where new code goes instead (rules only).
  // A missing file is skipped, so each lands with its extension point.
  'src/server/rooms/CLAUDE.md': 3000,
  'src/client/net/CLAUDE.md': 3000,
  'src/client/render/CLAUDE.md': 3000,
  'src/core/ai/CLAUDE.md': 3000,
  'src/shared-types/CLAUDE.md': 3000,
};

function claudeMdViolations() {
  const out = [];
  for (const [rel, budget] of Object.entries(CLAUDE_MD_BUDGETS)) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    // Count LF bytes so a CRLF checkout measures the same as the blob.
    const bytes = Buffer.byteLength(text.replace(/\r\n/g, '\n'));
    if (bytes > budget) out.push({ rel, bytes, budget });
  }
  return out;
}

function reportClaudeMd(violations) {
  for (const v of violations) {
    console.error(
      `  ${v.rel}: ${v.bytes} bytes > budget ${v.budget}. CLAUDE.md holds rules only: ` +
        `move how-it-works text, thresholds and history to the matching docs/architecture guide ` +
        `and leave a one-line pointer (root CLAUDE.md "What goes where").`,
    );
  }
}

/**
 * Where to put the growth instead. Longest matching path prefix wins. A cap or
 * ceiling failure prints this so the fix is a move to the extension point,
 * never a comment trim or a cap raise (docs/architecture/god-file-extension-points.md).
 */
const EXTEND_GUIDE = {
  'src/server/rooms/': 'src/server/rooms/CLAUDE.md',
  'src/server/index.ts': 'src/server/CLAUDE.md',
  'src/client/net/': 'src/client/net/CLAUDE.md',
  'src/client/render/': 'src/client/render/CLAUDE.md',
  'src/core/ai/': 'src/core/ai/CLAUDE.md',
  'src/core/contracts/': 'src/client/render/CLAUDE.md',
  'src/shared-types/': 'src/shared-types/CLAUDE.md',
};
const EXTEND_DOC = 'docs/architecture/god-file-extension-points.md';

function extendHint(rel) {
  let best = '';
  for (const prefix of Object.keys(EXTEND_GUIDE)) {
    if (rel.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  const guide = best ? EXTEND_GUIDE[best] : null;
  return (
    '    Fix: move the new code to this file’s extension point (a new small file), ' +
    'do not trim comments or raise the cap. See ' +
    (guide ? guide + ' and ' : '') + EXTEND_DOC + '.'
  );
}

/** Skip-list for files we deliberately leave > 600 LOC out of scope. Empty. */
const SKIP = new Set([]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.name === '__fixtures__' || entry.name === '__offscreen-spike__') continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      yield full;
    }
  }
}

function loc(file) {
  return readFileSync(file, 'utf8').split('\n').length;
}

function main() {
  if (process.argv.includes('--claude-md')) {
    const v = claudeMdViolations();
    if (v.length === 0) {
      console.log(
        `✓ audit-god-files --claude-md: ${Object.keys(CLAUDE_MD_BUDGETS).length} files within budget`,
      );
      process.exit(0);
    }
    console.error(`✗ audit-god-files --claude-md: ${v.length} file(s) over budget\n`);
    reportClaudeMd(v);
    process.exit(1);
  }
  const reportMode = process.argv.includes('--report');
  const violations = [];
  const allFiles = [];
  for (const file of walk(SRC_DIR)) {
    try {
      statSync(file);
    } catch {
      continue;
    }
    const lines = loc(file);
    const rel = relative(REPO_ROOT, file).split('\\').join('/');
    allFiles.push({ rel, lines });

    const allow = ALLOWLIST[rel];
    if (allow) {
      if (lines > allow.cap + CAP_SLACK) {
        violations.push({
          rel,
          lines,
          limit: allow.cap,
          kind: 'cap',
          reason: allow.reason,
          target: allow.target,
        });
      }
    } else if (lines > CEILING_LOC && !SKIP.has(rel)) {
      violations.push({ rel, lines, limit: CEILING_LOC, kind: 'ceiling' });
    }
  }

  if (reportMode) {
    allFiles.sort((a, b) => b.lines - a.lines);
    console.log('# Top 25 src/** files by LOC');
    for (const f of allFiles.slice(0, 25)) {
      const allow = ALLOWLIST[f.rel];
      const tag = allow
        ? `[allowlist cap=${allow.cap} target=${allow.target}]`
        : f.lines > CEILING_LOC
          ? '[OVER ceiling]'
          : '';
      console.log(`  ${String(f.lines).padStart(5)}  ${f.rel}  ${tag}`);
    }
    process.exit(0);
  }

  const mdViolations = claudeMdViolations();
  if (violations.length === 0 && mdViolations.length === 0) {
    console.log(
      `✓ audit-god-files: 0 violations (ceiling ${CEILING_LOC} LOC, ${Object.keys(ALLOWLIST).length} allowlisted)`,
    );
    process.exit(0);
  }

  console.error(`✗ audit-god-files: ${violations.length + mdViolations.length} violation(s)\n`);
  reportClaudeMd(mdViolations);
  for (const v of violations) {
    if (v.kind === 'ceiling') {
      console.error(
        `  ${v.rel}: ${v.lines} LOC > ceiling ${v.limit}. ` +
          `Split it OR add an ALLOWLIST entry in scripts/audit-god-files.mjs with cap+target+reason.
` +
          extendHint(v.rel),
      );
    } else {
      console.error(
        `  ${v.rel}: ${v.lines} LOC > allowlist cap ${v.limit} (+${CAP_SLACK} slack). ` +
          `File grew; cap was set to prevent backsliding during the v3 refactor.\n` +
          `    target=${v.target}; reason: ${v.reason}
` +
          extendHint(v.rel),
      );
    }
  }
  process.exit(1);
}

main();
