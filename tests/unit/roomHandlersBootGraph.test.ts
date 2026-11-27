/**
 * Boot guard: the room message handlers load early at boot. The renderer's
 * structure-art graph (`render/pixi/structureStyleC*`) has an import cycle;
 * a handler that reaches it at RUN time enters the cycle half way and the
 * browser throws a TDZ ReferenceError ("Cannot access 'roadStatus' before
 * initialization": a blank page). Vitest's module runner does not reproduce
 * the TDZ, so this walks the runtime import graph (type-only imports are
 * erased, so they are skipped) from each handler and fails on any path in.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src');
const HANDLERS = join(SRC, 'client/net/handlers');
const ART = /[\\/]client[\\/]render[\\/]pixi[\\/]structureStyleC[^\\/]*$/;

/** Runtime specifiers of a module: `import x from`, `import 'x'`, `export … from`, `import('x')`; not `import type` / `export type`. */
function runtimeSpecifiers(code: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'"]*?)from\s*['"]([^'"]+)['"]/g;
  for (let m = stmt.exec(code); m !== null; m = stmt.exec(code)) {
    if (m[2] !== undefined) continue; // `import type` / `export type`
    const clause = m[3]!.trim();
    // `import { type A, type B } from` is erased too.
    if (/^\{[^}]*\}$/.test(clause) && clause.slice(1, -1).split(',').every((p) => p.trim() === '' || p.trim().startsWith('type '))) continue;
    out.push(m[4]!);
  }
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = bare.exec(code); m !== null; m = bare.exec(code)) out.push(m[1]!);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dyn.exec(code); m !== null; m = dyn.exec(code)) out.push(m[1]!);
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@shared-types/')) base = join(SRC, 'shared-types', spec.slice('@shared-types/'.length));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package
  const stem = base.replace(/\.(js|ts|tsx)$/, '');
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(stem + ext)) return stem + ext;
  return null;
}

/** The first runtime import path from `start` into the structure art, or null. */
function pathIntoArt(start: string): string[] | null {
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      const to = resolveSpec(file, spec);
      if (to === null || prev.has(to)) continue;
      prev.set(to, file);
      if (ART.test(to)) {
        const path: string[] = [];
        for (let c: string | null = to; c !== null; c = prev.get(c) ?? null) path.unshift(relative(SRC, c));
        return path;
      }
      queue.push(to);
    }
  }
  return null;
}

describe('room handlers never reach the structure art at run time', () => {
  const handlers = readdirSync(HANDLERS).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  it.each(handlers)('%s', (f) => {
    expect(pathIntoArt(join(HANDLERS, f))).toBeNull();
  });
});
