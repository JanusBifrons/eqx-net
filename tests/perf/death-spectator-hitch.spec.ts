import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { test, type Page } from '@playwright/test';
import { waitForInPlay } from '../e2e/helpers/gameScenario';
import { DEFAULT_BASE_URL } from '../e2e/helpers/ports';

/**
 * Death → spectator frame-hitch MEASUREMENT (print-only, gates nothing).
 *
 * Symptom (2026-11-10 player-view clips, 60 fps desktop, `worker=0`): a
 * 50–67 ms stall (3–4 frames) at the exact moment the local ship dies and the
 * client flips into spectator (`pack-battle` 0.90 s, `capital-guns-fighter`
 * 14.47 s; a take log put one 72 ms long frame in Colyseus `onMessageCallback`).
 *
 * Recipe: join `test-sector-fast` on the main-thread renderer, let it settle,
 * then drive the client death path via the DEV `__eqxKillLocalShip` hook (the
 * same `killEntity` a server `destroy` message runs). Around the kill we take a
 * CDP CPU profile and record Long Animation Frames, then print the worst frame,
 * its script attribution and the profile's top self-time functions.
 *
 * Per CLAUDE.md "gate on counts, compare timings" this asserts nothing about
 * time; compare runs from the same machine and session. The count lock lives in
 * `src/client/components/BottomControlPanel.test.tsx`.
 *
 *   EQX_E2E_PORT_OFFSET=<free N> pnpm e2e:perf tests/perf/death-spectator-hitch.spec.ts --reporter=line
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const REPS = Number(process.env['DEATH_HITCH_REPS'] ?? '4');

interface LoafOut {
  start: number;
  duration: number;
  blocking: number;
  scripts: { invoker: string; fn: string; src: string; duration: number }[];
}

/**
 * A minimal React DevTools hook stub: React calls `onCommitFiberRoot` on every
 * commit. While `__eqxCommitLog` is an array we walk the committed tree and
 * record how many components rendered (PerformedWork flag) or mounted, by name.
 */
const COMMIT_PROBE = `
(() => {
  const nameOf = (f) => { const t = f.type; if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject() { return 1; },
    onScheduleFiberRoot() {}, onPostCommitFiberRoot() {}, onCommitFiberUnmount() {},
    onCommitFiberRoot(_id, root) {
      const log = window.__eqxCommitLog; if (!log) return;
      let rendered = 0, mounted = 0; const names = {};
      const stack = [root.current];
      while (stack.length) { const f = stack.pop();
        const n = nameOf(f);
        if (n) { const isMount = f.alternate === null; const did = isMount || (f.flags & 1) === 1;
          if (did) { rendered++; if (isMount) mounted++; names[n] = (names[n] || 0) + 1; }
          if (isMount && f.return && f.return.alternate !== null) { let p = f.return, pn = null; while (p && !(pn = nameOf(p))) p = p.return; const k = 'MOUNT-ROOT ' + n + ' under ' + pn; names[k] = (names[k] || 0) + 1; } }
        // An untouched subtree keeps the same child fibers (complete bailout): skip it.
        if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
      log.push({ t: performance.now(), rendered, mounted, names });
    },
  };
})();
`;

interface CommitOut { t: number; rendered: number; mounted: number; names: Record<string, number> }

async function join(page: Page): Promise<void> {
  const params = new URLSearchParams({
    room: 'test-sector-fast',
    shipKind: 'scout',
    spawnX: '0',
    spawnY: '0',
    worker: '0',
    testId: `death-hitch-${randomUUID()}`,
  });
  await page.goto(`${BASE_URL}?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    undefined,
    { timeout: 30_000 },
  );
  await waitForInPlay(page);
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
}

test('death → spectator long-frame attribution (print-only)', async ({ page }) => {
  test.setTimeout(140_000);
  const results: { worstMs: number; over34: number; rendered: number; mounted: number; loafs: LoafOut[]; top: string[] }[] = [];

  await page.addInitScript(COMMIT_PROBE);
  for (let rep = 0; rep < REPS; rep++) {
    await join(page);
    // Let boot-time work (atlas bakes, first snapshot churn) drain.
    await page.waitForTimeout(3_000);

    await page.evaluate(() => {
      const w = window as unknown as { __loafs: unknown[]; __loafObs?: PerformanceObserver };
      w.__loafs = [];
      w.__loafObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__loafs.push(e.toJSON());
      });
      w.__loafObs.observe({ type: 'long-animation-frame', buffered: false });
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');

    const t0 = await page.evaluate(() => {
      const t = performance.now();
      (window as unknown as { __eqxCommitLog?: unknown[] }).__eqxCommitLog = [];
      (window as unknown as { __eqxKillLocalShip?: () => void }).__eqxKillLocalShip?.();
      return t;
    });
    // Profile only the death moment (first ~300 ms); LoAFs keep recording.
    await page.waitForTimeout(300);

    const { profile } = (await cdp.send('Profiler.stop')) as {
      profile: {
        nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
        samples: number[];
        timeDeltas: number[];
      };
    };
    await cdp.detach();
    await page.waitForTimeout(1_200);

    const loafs = (await page.evaluate((start) => {
      const w = window as unknown as { __loafs: Array<Record<string, unknown>>; __loafObs?: PerformanceObserver };
      w.__loafObs?.disconnect();
      return w.__loafs
        .filter((e) => (e['startTime'] as number) >= start - 20)
        .map((e) => ({
          start: Math.round((e['startTime'] as number) - start),
          duration: Math.round(e['duration'] as number),
          blocking: Math.round((e['blockingDuration'] as number) ?? 0),
          scripts: ((e['scripts'] as Array<Record<string, unknown>>) ?? []).map((s) => ({
            invoker: String(s['invoker']),
            fn: String(s['sourceFunctionName']),
            src: String(s['sourceURL']).split('/').pop() ?? '',
            duration: Math.round(s['duration'] as number),
          })),
        }));
    }, t0)) as LoafOut[];

    // Self-time by function across the whole post-kill window.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]!)!;
      const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()?.split('?')[0]}:${n.callFrame.lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    }
    const top = [...self.entries()]
      .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${k}`);

    // React work in the 300 ms after the kill (the death-time cascade).
    const commits = (await page.evaluate((start) => {
      const w = window as unknown as { __eqxCommitLog?: CommitOut[] };
      const log = (w.__eqxCommitLog ?? []).filter((c) => c.t - start < 300);
      w.__eqxCommitLog = undefined;
      return log;
    }, t0)) as CommitOut[];
    const rendered = commits.reduce((a, c) => a + c.rendered, 0);
    const mounted = commits.reduce((a, c) => a + c.mounted, 0);
    const byName: Record<string, number> = {};
    for (const c of commits) for (const [k, v] of Object.entries(c.names)) byName[k] = (byName[k] ?? 0) + v;
    const mountRoots = Object.entries(byName).filter(([k]) => k.startsWith('MOUNT-ROOT')).map(([k, v]) => `${k.slice(11)}×${v}`);
    const topNames = Object.entries(byName)
      .filter(([k]) => !k.startsWith('MOUNT-ROOT'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, v]) => `${k}×${v}`);

    const worstMs = loafs.reduce((m, l) => Math.max(m, l.duration), 0);
    const over34 = loafs.filter((l) => l.duration > 34).length;
    results.push({ worstMs, over34, rendered, mounted, loafs, top });
    console.log(`\n[death-hitch] rep ${rep}: worst LoAF ${worstMs} ms, frames >34 ms: ${over34}`);
    console.log(`  react (300 ms after kill): ${commits.length} commits, ${rendered} components rendered, ${mounted} mounted`);
    console.log(`   ${topNames.join(' ')}`);
    console.log(`   mounted subtrees: ${mountRoots.join(' | ')}`);
    for (const l of loafs.slice(0, 6)) {
      console.log(`  loaf @+${l.start}ms ${l.duration}ms (blocking ${l.blocking})`);
      for (const s of l.scripts) console.log(`     ${s.duration}ms ${s.invoker} ${s.fn} ${s.src}`);
    }
    console.log('  top self-time (300 ms after kill):\n   ' + top.slice(0, 15).join('\n   '));
  }

  const worst = results.map((r) => r.worstMs).sort((a, b) => a - b);
  console.log(`\n[death-hitch] SUMMARY worst-LoAF per rep (sorted): ${worst.join(', ')} ms; median ${worst[Math.floor(worst.length / 2)]} ms`);
  mkdirSync('diag/perf-baseline', { recursive: true });
  writeFileSync('diag/perf-baseline/death-spectator-hitch.json', JSON.stringify(results, null, 2));
});
