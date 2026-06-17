import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Structural guard against a recurring trap (docs/LESSONS.md 2026-06-14 galaxy,
 * 2026-06-17 push): Vite's web root is `src/client`, so a top-level
 * `src/client/<dir>/` is served at `/<dir>/…`. If `<dir>` matches a `server.proxy`
 * prefix in vite.config.ts, the proxy HIJACKS the ESM module request and
 * forwards it to the game server → 404 → the app's import chain breaks → blank
 * app. The 2026-06-14 fix moved the dir; the 2026-06-17 fix renamed
 * `src/client/push/` → `src/client/notifications/` (the `/push` proxy carries the
 * API calls).
 *
 * A proxy with a source-file `bypass` (only `/auth` today) is exempt — it serves
 * `*.ts/.tsx/...` via Vite and only proxies non-source paths, so `src/client/auth/`
 * legitimately coexists with `/auth`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_DIR = path.join(ROOT, 'src', 'client');

// Proxy prefixes (without a source-file bypass) that forward to the game server.
// Keep in sync with vite.config.ts `server.proxy`; the cross-check below fails
// if a proxy is added/removed without updating this list (forcing a deliberate
// "does a client dir collide?" decision). `/auth` is intentionally absent — it
// has a `bypass`, so it does not hijack source modules.
const NO_BYPASS_PROXY_PREFIXES = ['matchmake', 'healthz', 'diag', 'dev', 'galaxy', 'push'];
const BYPASS_PROXY_PREFIXES = ['auth'];

function parseProxyKeys(): string[] {
  const src = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  const proxyStart = src.indexOf('proxy:');
  expect(proxyStart, 'vite.config.ts should declare server.proxy').toBeGreaterThan(-1);
  const block = src.slice(proxyStart);
  // Proxy keys are the only `'/word': {` string keys in the config (aliases use
  // '@core' etc.; the navigateFallback denylist is a regex literal).
  const keys = new Set<string>();
  for (const m of block.matchAll(/'\/(\w+)'\s*:\s*\{/g)) keys.add(m[1]!);
  return [...keys];
}

function topLevelClientDirs(): string[] {
  return readdirSync(CLIENT_DIR).filter((e) => {
    if (e.startsWith('.') || e.startsWith('__')) return false; // dotfiles + spikes
    return statSync(path.join(CLIENT_DIR, e)).isDirectory();
  });
}

describe('client dir vs vite proxy collision guard', () => {
  it('the hardcoded proxy lists match vite.config.ts server.proxy keys', () => {
    const actual = parseProxyKeys().sort();
    const expected = [...NO_BYPASS_PROXY_PREFIXES, ...BYPASS_PROXY_PREFIXES].sort();
    // If this fails: a proxy was added/removed. Update the lists above AND
    // confirm no `src/client/<dir>` collides with a new no-bypass prefix.
    expect(actual).toEqual(expected);
  });

  it('no top-level src/client dir is hijacked by a no-bypass proxy prefix', () => {
    const offenders = topLevelClientDirs().filter((dir) =>
      NO_BYPASS_PROXY_PREFIXES.some((p) => `/${dir}`.startsWith(`/${p}`)),
    );
    // Vite serves `/<dir>/file.ts`; a no-bypass proxy on `/<p>` forwards it to the
    // server (404) and the app never mounts. Rename the dir (e.g. push →
    // notifications) or nest it (e.g. render/galaxy/), or give the proxy a bypass.
    expect(offenders, `client dirs colliding with a no-bypass proxy: ${offenders.join(', ')}`).toEqual([]);
  });
});
