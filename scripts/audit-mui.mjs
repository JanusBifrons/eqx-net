/**
 * audit-mui.mjs — the MUI lint wall's shrink-only allowlist (ui-language plan C6).
 *
 * Raw `@mui/*` and `@emotion/*` imports belong in `src/ui/**` (the EQX
 * catalogue) only. The files that imported them when the wall went up are
 * listed in `scripts/mui-allowlist.json`; eslint.config.js reads the same
 * list to exempt them from the `no-restricted-imports` ban. The list may only
 * shrink:
 *
 *   1. A src/** file outside src/ui/** that imports MUI and is NOT on the list
 *      fails (use the src/ui catalogue instead).
 *   2. A listed file that no longer imports MUI, or no longer exists, fails
 *      until it is removed from the list.
 *
 * Test and story files count like any other file (one list, no special case).
 *
 * Usage:
 *   node scripts/audit-mui.mjs          # fail on violation
 *   node scripts/audit-mui.mjs --count  # print the allowlist count (pnpm ui:countdown)
 *
 * No shebang on purpose (see audit-god-files.mjs): vitest imports this file.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const ALLOWLIST_FILE = 'scripts/mui-allowlist.json';

const SKIP_DIRS = new Set(['node_modules', 'dist']);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** `from '@mui/…'`, `import '@mui/…'`, `import('@mui/…')`, `require('@mui/…')`, same for @emotion. */
const MUI_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]@(?:mui|emotion)\//;

/** Whether source text imports MUI or Emotion. */
export function importsMui(text) {
  return MUI_IMPORT.test(text);
}

/** Whether a repo-root-relative POSIX path is in scope: src/** code outside the catalogue. */
export function inScope(rel) {
  if (!rel.startsWith('src/') || rel.startsWith('src/ui/')) return false;
  if (!CODE_FILE.test(rel) || rel.endsWith('.d.ts')) return false;
  return !rel.split('/').slice(0, -1).some((seg) => SKIP_DIRS.has(seg));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Every in-scope file under `root/src` that imports MUI, sorted, repo-relative POSIX. */
export function findImporters(root = REPO_ROOT) {
  const src = join(root, 'src');
  if (!existsSync(src)) return [];
  const out = [];
  for (const file of walk(src)) {
    const rel = relative(root, file).split('\\').join('/');
    if (!inScope(rel)) continue;
    if (importsMui(readFileSync(file, 'utf8'))) out.push(rel);
  }
  return out.sort();
}

/** The allowlist as an array of repo-relative paths. */
export function readAllowlist(root = REPO_ROOT) {
  const list = JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), 'utf8'));
  if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) {
    throw new Error(`${ALLOWLIST_FILE} must be a JSON array of paths`);
  }
  return list;
}

/**
 * The one rule. Returns violations:
 *   { kind: 'new', rel }      — imports MUI, not on the list
 *   { kind: 'stale', rel }    — on the list, no longer imports MUI
 *   { kind: 'missing', rel }  — on the list, file is gone
 *   { kind: 'unsorted' } / { kind: 'duplicate', rel }
 */
export function audit(root = REPO_ROOT) {
  const list = readAllowlist(root);
  const listed = new Set(list);
  const importers = new Set(findImporters(root));
  const violations = [];
  for (const rel of importers) if (!listed.has(rel)) violations.push({ kind: 'new', rel });
  const seen = new Set();
  for (const rel of list) {
    if (seen.has(rel)) violations.push({ kind: 'duplicate', rel });
    seen.add(rel);
    if (importers.has(rel)) continue;
    violations.push({ kind: existsSync(join(root, rel)) ? 'stale' : 'missing', rel });
  }
  if (list.join('\n') !== [...list].sort().join('\n')) violations.push({ kind: 'unsorted' });
  return { count: list.length, violations };
}

/** One human line per violation. */
export function describe(v) {
  switch (v.kind) {
    case 'new':
      return `  ${v.rel}: imports @mui/@emotion outside src/ui. Use the src/ui catalogue (EQX entries) instead; the allowlist only shrinks.`;
    case 'stale':
      return `  ${v.rel}: no longer imports @mui/@emotion. Remove it from the allowlist (${ALLOWLIST_FILE}).`;
    case 'missing':
      return `  ${v.rel}: file no longer exists. Remove it from the allowlist (${ALLOWLIST_FILE}).`;
    case 'duplicate':
      return `  ${v.rel}: listed twice. Remove the duplicate from the allowlist (${ALLOWLIST_FILE}).`;
    default:
      return `  ${ALLOWLIST_FILE} is not sorted. Keep it sorted.`;
  }
}

function main() {
  if (process.argv.includes('--count')) {
    console.log(`MUI allowlist: ${readAllowlist().length} files left`);
    return;
  }
  const { count, violations } = audit();
  if (violations.length === 0) {
    console.log(`✓ audit-mui: 0 violations (${count} files on the shrink-only MUI allowlist)`);
    return;
  }
  console.error(`✗ audit-mui: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(describe(v));
  process.exitCode = 1;
}

const isMain = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
