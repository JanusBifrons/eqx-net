#!/usr/bin/env node
/**
 * Dependency vulnerability audit via npm's BULK advisory endpoint.
 *
 * 2026-07-16: npm retired the classic audit endpoint
 * (`/-/npm/v1/security/audits`, now HTTP 410) that `pnpm audit` calls — the
 * CI verify job died on infrastructure, not on a vulnerability. This script
 * reproduces the same gate (`fail on high/critical advisories affecting
 * PRODUCTION dependencies`) against the replacement endpoint
 * (`/-/npm/v1/security/advisories/bulk`) documented at
 * https://api-docs.npmjs.com/#tag/Audit. Swap back to `pnpm audit` once pnpm
 * speaks the bulk endpoint.
 *
 * Prod-only scoping: walks the lockfile's importer `dependencies` (not
 * devDependencies) transitively through `snapshots`, mirroring
 * `pnpm audit --prod`.
 */
import { readFileSync } from 'node:fs';

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');

// Minimal lockfile-v9 reader — no YAML dep. We only need three shapes:
//   importers  -> '.': dependencies: <name>: { version: <ver(peers)> }
//   snapshots  -> '<name>@<ver>(peers)': dependencies: <name>: <ver(peers)>
// Indentation is fixed (2 spaces per level) in pnpm-generated lockfiles.
const lines = lock.split('\n');

function sectionRange(header) {
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') { end = i; break; }
  }
  return [start + 1, end];
}

/** Parse `snapshots:` into Map<pkgKey, depSpecs[]> where pkgKey = name@version(peers…). */
function parseSnapshots() {
  const range = sectionRange('snapshots:');
  const out = new Map();
  if (!range) return out;
  let current = null;
  let inDeps = false;
  for (let i = range[0]; i < range[1]; i++) {
    const l = lines[i];
    const keyMatch = /^  (\S.*?):\s*$/.exec(l);
    if (keyMatch && !l.startsWith('    ')) {
      current = keyMatch[1].replace(/^['"]|['"]$/g, '');
      out.set(current, []);
      inDeps = false;
      continue;
    }
    if (current && /^    (dependencies|optionalDependencies):\s*$/.test(l)) { inDeps = true; continue; }
    if (current && /^    \S/.test(l)) { inDeps = false; continue; }
    if (current && inDeps) {
      const dep = /^      (\S.*?): (.+)$/.exec(l);
      if (dep) out.get(current).push([dep[1].replace(/^['"]|['"]$/g, ''), dep[2].replace(/^['"]|['"]$/g, '')]);
    }
  }
  return out;
}

/** Parse the root importer's PROD dependency specs.
 *  Shape: `  .:` → `    dependencies:` → `      <name>:` →
 *  `        specifier: …` / `        version: <resolved>` */
function parseRootProdDeps() {
  const range = sectionRange('importers:');
  const out = [];
  if (!range) return out;
  let inRoot = false;
  let inDeps = false;
  let depName = null;
  for (let i = range[0]; i < range[1]; i++) {
    const l = lines[i];
    if (/^  \.:\s*$/.test(l)) { inRoot = true; continue; }
    if (inRoot && /^  \S/.test(l)) break; // next importer
    if (inRoot && /^    dependencies:\s*$/.test(l)) { inDeps = true; depName = null; continue; }
    if (inRoot && /^    \S/.test(l)) { inDeps = false; depName = null; continue; }
    if (inRoot && inDeps) {
      const nameLine = /^      (\S.*?):\s*$/.exec(l);
      if (nameLine) { depName = nameLine[1].replace(/^['"]|['"]$/g, ''); continue; }
      const ver = /^        version: (.+)$/.exec(l);
      if (ver && depName) out.push([depName, ver[1].trim()]);
    }
  }
  return out;
}

function keyOf(name, spec) {
  // spec is like `1.2.3(peerA@x)(peerB@y)` or a link:/file: — skip non-registry.
  if (/^(link|file|workspace):/.test(spec)) return null;
  return `${name}@${spec}`;
}

const snapshots = parseSnapshots();
const seen = new Set();
const queue = [];
for (const [name, spec] of parseRootProdDeps()) {
  const k = keyOf(name, spec);
  if (k) queue.push(k);
}
while (queue.length) {
  const k = queue.pop();
  if (seen.has(k)) continue;
  seen.add(k);
  const deps = snapshots.get(k) ?? [];
  for (const [dn, dspec] of deps) {
    const dk = keyOf(dn, dspec);
    if (dk && !seen.has(dk)) queue.push(dk);
  }
}

// Collapse to name -> Set<bare version> (strip peer suffixes).
const byName = new Map();
for (const k of seen) {
  const at = k.lastIndexOf('@');
  const name = k.slice(0, at);
  const ver = k.slice(at + 1).replace(/\(.*$/, '');
  if (!/^\d/.test(ver)) continue; // non-registry (git/tarball) — endpoint can't rate them
  if (!byName.has(name)) byName.set(name, new Set());
  byName.get(name).add(ver);
}

const payload = {};
for (const [name, vers] of byName) payload[name] = [...vers];
console.log(`auditing ${Object.keys(payload).length} production packages via the bulk advisory endpoint…`);

const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
if (!res.ok) {
  console.error(`bulk advisory endpoint answered ${res.status} — treating as infrastructure failure`);
  process.exit(2);
}
const advisories = await res.json();

const FAIL_SEVERITIES = new Set(['high', 'critical']);
let failCount = 0;
for (const [name, advs] of Object.entries(advisories)) {
  for (const adv of advs) {
    const line = `${adv.severity.toUpperCase()} ${name} ${adv.vulnerable_versions} — ${adv.title} (${adv.url})`;
    if (FAIL_SEVERITIES.has(adv.severity)) {
      failCount++;
      console.error(`FAIL ${line}`);
    } else {
      console.log(`info ${line}`);
    }
  }
}
if (failCount > 0) {
  console.error(`\n${failCount} high/critical advisories affect production dependencies.`);
  process.exit(1);
}
console.log('no high/critical advisories in production dependencies.');
