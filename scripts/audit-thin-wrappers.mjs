#!/usr/bin/env node
/**
 * audit-thin-wrappers.mjs — Inv #14 enforcement.
 *
 * When an extraction moves a method out of a class, the original
 * method MUST be either deleted in the same commit OR marked
 * `@deprecated` with a TODO referencing the cleanup commit. This script
 * greps for thin one-liner private methods that look like:
 *
 *   private someName(...args) { return helper.someName(...args); }
 *
 * Each match is reported with the file:line. The script does NOT fail
 * on `@deprecated`-tagged wrappers — those are intentional bridges
 * pending a cleanup commit landing in the same PR.
 *
 * Targets only `src/server/rooms/SectorRoom.ts` and
 * `src/client/net/ColyseusClient.ts` for now (the two orchestrators
 * the v3 plan extracts from); extend the FILES list as the refactor
 * teaches us where wrappers accumulate.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const FILES = [
  'src/server/rooms/SectorRoom.ts',
  'src/client/net/ColyseusClient.ts',
];

/**
 * Thin-wrapper signature: `private name(args): T { return module.name(args); }`
 * — one-line body returning a single delegate call. Multiline wrappers,
 * wrappers that add behaviour, and public methods (which may legitimately
 * be a stable API surface) are NOT flagged.
 */
const WRAPPER_PATTERN =
  /^\s+private\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*return\s+(\w+)\.\w+\([^)]*\);\s*\}\s*$/;

const DEPRECATED_PATTERN = /@deprecated/;

function audit(filePath) {
  const full = join(REPO_ROOT, filePath);
  try {
    statSync(full);
  } catch {
    return { skipped: true, file: filePath };
  }
  const content = readFileSync(full, 'utf8');
  const lines = content.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!WRAPPER_PATTERN.test(line)) continue;
    // Look back up to 6 lines for a @deprecated marker on this method.
    let isDeprecated = false;
    for (let j = Math.max(0, i - 6); j < i; j++) {
      if (DEPRECATED_PATTERN.test(lines[j])) {
        isDeprecated = true;
        break;
      }
    }
    if (!isDeprecated) {
      findings.push({ line: i + 1, text: line.trim() });
    }
  }
  return { skipped: false, file: filePath, findings };
}

function main() {
  let totalFindings = 0;
  for (const file of FILES) {
    const result = audit(file);
    if (result.skipped) {
      console.log(`  ${file}: SKIPPED (file not found)`);
      continue;
    }
    if (result.findings.length === 0) {
      console.log(`✓ ${file}: 0 thin wrappers`);
      continue;
    }
    totalFindings += result.findings.length;
    console.error(`✗ ${file}: ${result.findings.length} thin wrapper(s)`);
    for (const f of result.findings) {
      console.error(`    ${file}:${f.line}  ${f.text}`);
    }
  }
  if (totalFindings === 0) {
    console.log('✓ audit-thin-wrappers: 0 violations');
    process.exit(0);
  }
  console.error(
    `\n  Inv #14: thin delegating wrappers must be deleted in the same PR ` +
      `as the extraction. Mark with @deprecated + TODO if the deletion lands in a` +
      ` later commit of the same PR.`,
  );
  process.exit(1);
}

main();
