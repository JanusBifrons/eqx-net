/**
 * Compare a 60s IDLE window heap diff to a 60s ACTIVE-COMBAT window
 * heap diff. Anything growing in IDLE is structurally leaking outside
 * combat (background timers, polling subscribers, etc).
 *
 * Procedure: one Playwright session, two consecutive heap-snapshot pairs
 *   t=10s  → first snapshot (post-warmup)
 *   t=70s  → second snapshot (60s of IDLE — no keys pressed)
 *   t=72s  → third snapshot (start of combat)
 *   t=132s → fourth snapshot (60s of held-fire active combat)
 *
 * Diff A (idle window):   snap2 - snap1
 * Diff B (combat window): snap4 - snap3
 *
 * Combat-only growth = (B - A) per type. Eliminates background noise.
 */
import { chromium, type CDPSession } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffSnapshots, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

const BASE = process.env['BASE'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-31-idle-vs-combat';
const WINDOW_S = 60;

async function takeHeapSnapshot(cdp: CDPSession): Promise<string> {
  const chunks: string[] = [];
  const onChunk = ({ chunk }: { chunk: string }): void => { chunks.push(chunk); };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  return chunks.join('');
}

async function gcAndSnap(cdp: CDPSession, label: string): Promise<string> {
  console.log(`[probe] ${label} → GC + heap snapshot`);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  return takeHeapSnapshot(cdp);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '0',
    testId: `idle-vs-combat-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    worker: '0',
  });
  console.log('[probe] booting…');
  await page.goto(`${BASE}/?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
  }, { timeout: 15_000 });
  await page.waitForTimeout(8000);

  const snap1 = await gcAndSnap(cdp, 'snap1 (idle baseline)');
  console.log(`[probe] ${WINDOW_S}s of IDLE (no keys pressed)…`);
  await page.waitForTimeout(WINDOW_S * 1000);
  const snap2 = await gcAndSnap(cdp, 'snap2 (after 60s idle)');

  console.log('[probe] start combat (W + Space held)…');
  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  await page.waitForTimeout(2000);
  const snap3 = await gcAndSnap(cdp, 'snap3 (combat baseline)');
  console.log(`[probe] ${WINDOW_S}s of ACTIVE combat…`);
  await page.waitForTimeout(WINDOW_S * 1000);
  const snap4 = await gcAndSnap(cdp, 'snap4 (after 60s combat)');
  await page.keyboard.up('w');
  await page.keyboard.up('Space');

  await ctx.close();
  await browser.close();

  const idle = diffSnapshots(JSON.parse(snap1) as SnapshotJson, JSON.parse(snap2) as SnapshotJson);
  const combat = diffSnapshots(JSON.parse(snap3) as SnapshotJson, JSON.parse(snap4) as SnapshotJson);

  // Match by type+name
  const idleMap = new Map<string, { sizeDelta: number; countDelta: number }>();
  for (const d of idle) {
    idleMap.set(`${d.type}:${d.name ?? ''}`, { sizeDelta: d.sizeDeltaBytes, countDelta: d.countDelta });
  }

  type Row = {
    key: string;
    type: string;
    name: string;
    idleSize: number;
    idleCount: number;
    combatSize: number;
    combatCount: number;
    deltaSize: number;
    deltaCount: number;
  };
  const rows: Row[] = combat.map((d) => {
    const key = `${d.type}:${d.name ?? ''}`;
    const idleEntry = idleMap.get(key);
    return {
      key,
      type: d.type,
      name: d.name ?? '',
      idleSize: idleEntry?.sizeDelta ?? 0,
      idleCount: idleEntry?.countDelta ?? 0,
      combatSize: d.sizeDeltaBytes,
      combatCount: d.countDelta,
      deltaSize: d.sizeDeltaBytes - (idleEntry?.sizeDelta ?? 0),
      deltaCount: d.countDelta - (idleEntry?.countDelta ?? 0),
    };
  });

  // Top combat-only growers (combat-side growth NOT explained by idle).
  rows.sort((a, b) => b.deltaSize - a.deltaSize);

  const md: string[] = [
    `# Idle-vs-combat heap diff (each window = ${WINDOW_S}s, worker=0)`,
    ``,
    `**Idle window**: page loaded, no key input. Anything growing here is a structural leak (background polling, async timers, ring-buffer growth).`,
    `**Combat window**: held-fire + thrust for ${WINDOW_S}s.`,
    `**Δ = combat growth - idle growth** isolates combat-only allocators.`,
    ``,
    `## Top 30 combat-only growers (Δ size)`,
    ``,
    `| Type | Name | Idle Δcount | Combat Δcount | Combat-only Δcount | Combat-only Δsize (KB) |`,
    `|---|---|---:|---:|---:|---:|`,
    ...rows.slice(0, 30).map((r) =>
      `| ${r.type} | ${r.name.slice(0, 60)} | ${r.idleCount} | ${r.combatCount} | ${r.deltaCount} | ${(r.deltaSize / 1024).toFixed(2)} |`,
    ),
    ``,
    `## Top 20 IDLE growers (should be near zero or near a known baseline)`,
    ``,
    `| Type | Name | Idle Δcount | Idle Δsize (KB) |`,
    `|---|---|---:|---:|`,
    ...idle
      .sort((a, b) => b.sizeDeltaBytes - a.sizeDeltaBytes)
      .slice(0, 20)
      .map((d) => `| ${d.type} | ${(d.name ?? '').slice(0, 60)} | ${d.countDelta} | ${(d.sizeDeltaBytes / 1024).toFixed(2)} |`),
  ];
  const summary = md.join('\n');
  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  await writeFile(join(OUT_DIR, `idle-vs-combat-${ts}.md`), summary);
  await writeFile(join(OUT_DIR, `snap1-idle-baseline-${ts}.heapsnapshot`), snap1);
  await writeFile(join(OUT_DIR, `snap2-after-idle-${ts}.heapsnapshot`), snap2);
  await writeFile(join(OUT_DIR, `snap3-combat-baseline-${ts}.heapsnapshot`), snap3);
  await writeFile(join(OUT_DIR, `snap4-after-combat-${ts}.heapsnapshot`), snap4);

  console.log(`\n${summary}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
