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
  'src/server/rooms/SectorRoom.ts': {
    cap: 2500,
    target: 450,
    reason:
      'v3 plan commits 20-23 split this into 17 collaborators (PhysicsWorkerProxy, ' +
      'PlayerSlotMap, SwarmRegistry, CombatResolver, LagCompRing, WeaponMountTicker, ' +
      'BroadcastScheduler, etc.); orchestrator target ~450 LOC.',
  },
  'src/client/net/ColyseusClient.ts': {
    cap: 3530,
    target: 350,
    reason:
      'v3 plan commits 16-19 split this into 15 collaborators (PredictionStateManager, ' +
      'SnapshotApplier, MirrorUpdater, etc.); orchestrator target ~350 LOC.',
  },
  'src/client/render/PixiRenderer.ts': {
    cap: 1190,
    target: 340,
    reason:
      'v3 plan commits 10-14 split this into 15 collaborators (PixiAppLifecycle, ' +
      'CameraController, SpriteFactory, SpriteRegistry, ShipSpriteUpdater, etc.); ' +
      'orchestrator target ~340 LOC.',
  },
};

/**
 * Byte budgets for the auto-injected instruction files (repo-root-relative),
 * measured with LF line endings. Set from the sizes after the 2026-11-14
 * CLAUDE.md diet plus ~5% headroom. Lower a budget when a file shrinks;
 * never raise one to fit new text: move detail to a docs/ guide instead.
 */
const CLAUDE_MD_BUDGETS = {
  'CLAUDE.md': 32000,
  'src/server/CLAUDE.md': 35500,
  'src/client/CLAUDE.md': 31500,
  'src/core/CLAUDE.md': 19500,
  'plans/CLAUDE.md': 3000,
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
      console.log(`✓ audit-god-files --claude-md: ${Object.keys(CLAUDE_MD_BUDGETS).length} files within budget`);
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
          `Split it OR add an ALLOWLIST entry in scripts/audit-god-files.mjs with cap+target+reason.`,
      );
    } else {
      console.error(
        `  ${v.rel}: ${v.lines} LOC > allowlist cap ${v.limit} (+${CAP_SLACK} slack). ` +
          `File grew; cap was set to prevent backsliding during the v3 refactor.\n` +
          `    target=${v.target}; reason: ${v.reason}`,
      );
    }
  }
  process.exit(1);
}

main();
