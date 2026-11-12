/**
 * Perf lab scene list (plan prancy-squishing-donut P3b). Each link opens the
 * real game in a `perf-<id>` room with the probe on; the game frames the
 * scene, measures it and posts the reading (`runPerfLabScene`).
 */
import { PERF_SCENES } from '@shared-types/perf/perfScenes';

const list = document.getElementById('list')!;

// Phase 4 travel state: a real sector-to-sector trip (needs the server run with
// EQX_SOLAR_SECTORS=1 and EQX_GALAXY_SECTORS=sol-prime,vega-reach).
{
  const p = new URLSearchParams({
    galaxy: 'sol-prime', solar: '1', spawnX: '0', spawnY: '0', shipKind: 'fighter',
    art: 'machined', fx: 'new', diag: '0', perfprobe: '1', perftrip: 'vega-reach',
  });
  const a = document.createElement('a');
  a.className = 'scene';
  a.href = `/?${p}`;
  const b = document.createElement('b');
  b.textContent = 'Sector trip (Sol Prime → Vega Reach)';
  const s = document.createElement('span');
  s.textContent = '~70 s · 30 s spool, the trip, the landing';
  a.append(b, s);
  list.appendChild(a);
}
for (const scene of PERF_SCENES) {
  const p = new URLSearchParams({
    room: `perf-${scene.id}`,
    // Not crypto.randomUUID: the phone opens this over plain http on the LAN (not a secure context).
    testId: `lab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
    spawnX: String(scene.spawn.x),
    spawnY: String(scene.spawn.y),
    shipKind: scene.pilotKind ?? 'fighter',
    initialHull: '1000000',
    art: 'machined',
    fx: 'new',
    diag: '0',
    perfprobe: '1',
    perfscene: scene.id,
  });
  const a = document.createElement('a');
  a.className = 'scene';
  a.href = `/?${p}`;
  const b = document.createElement('b');
  b.textContent = scene.title;
  const s = document.createElement('span');
  s.textContent = `${Math.round(scene.durationMs / 1000)} s · ${scene.id}`;
  a.append(b, s);
  list.appendChild(a);
}
