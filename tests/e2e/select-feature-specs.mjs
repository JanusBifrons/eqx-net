/**
 * Which feature specs should this change run? (test audit 2026-11-06)
 *
 *   node tests/e2e/select-feature-specs.mjs [baseRef]     (default origin/main)
 *
 * Prints spec paths, space-separated (empty when none), for
 * `playwright test --project=feature <paths>`. Reads the changed files from
 * `git diff --name-only <base>...HEAD`. Quarantined specs never run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { FEATURE_TRIGGERS, QUARANTINE } from './featureTriggers.mjs';

/** Smoke specs already run on every PR (their names, from playwright.config.ts). */
function smokeNames() {
  try {
    const cfg = readFileSync('playwright.config.ts', 'utf8');
    const block = /const SMOKE_SPECS[^=]*=\s*\[([\s\S]*?)\];/.exec(cfg)?.[1] ?? '';
    return new Set([...block.matchAll(/'\*\*\/([^']+)\.spec\.ts'/g)].map((m) => m[1]));
  } catch { return new Set(); }
}

const baseName = (s) => s.split('/').pop();

export function selectFeatureSpecs(changed) {
  const smoke = smokeNames();
  const out = new Set();
  for (const f of changed) {
    const m = /^tests\/e2e\/(.+)\.spec\.ts$/.exec(f);
    if (m) out.add(m[1]);
    for (const t of FEATURE_TRIGGERS) if (t.paths.some((p) => f.startsWith(p))) for (const s of t.specs) out.add(s);
  }
  return [...out].filter((s) => !QUARANTINE.has(baseName(s)) && !smoke.has(s) && !smoke.has(baseName(s))).sort();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const base = process.argv[2] ?? 'origin/main';
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const specs = selectFeatureSpecs(changed)
    .map((s) => (existsSync(`tests/e2e/${s}.spec.ts`) ? `tests/e2e/${s}.spec.ts` : `tests/e2e/combat/${s}.spec.ts`))
    .filter((p) => existsSync(p));
  process.stdout.write(specs.join(' '));
}
