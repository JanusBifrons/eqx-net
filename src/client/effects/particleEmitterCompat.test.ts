/**
 * `@pixi/particle-emitter` worker-compat — automated portion of milestone
 * M0.5 of the visual-effects subsystem plan.
 *
 * The full spike is a browser-side OffscreenCanvas worker probe at
 * `src/client/__offscreen-spike__/particle-emitter-probe.html` — the human
 * verifies live behaviour there. This file catches the cheapest failure
 * mode automatically: an `import` that crashes because the library touches
 * `document` / `window` at module-evaluation time.
 *
 * Also asserts the `Emitter` constructor exists and is a function, so a
 * deps-version drift that renames or removes the symbol fails CI loudly.
 *
 * Source-level evidence already gathered before adding the dep:
 *   grep -E '(\bdocument\.|\bwindow\.|addEventListener|navigator\.|location\.)' \
 *     node_modules/@pixi/particle-emitter/lib/particle-emitter.es.js
 * → zero matches.
 */

import { describe, expect, it } from 'vitest';

describe('@pixi/particle-emitter worker-compat (M0.5 automated portion)', () => {
  it('imports without touching `document` or `window` at module-load', async () => {
    const mod = await import('@pixi/particle-emitter');
    expect(mod).toBeTruthy();
    expect(typeof mod.Emitter).toBe('function');
  });
});
