/**
 * Visual-effects test harness — boots the production
 * `WorkerRendererClient` with no networking, and drives the renderer's
 * effect APIs from a looping per-effect scenario that demonstrates the
 * visual in a realistic flow. Param sliders live-tune the visual while
 * the loop plays; manual buttons (ON / OFF / canvas tap) pause the
 * scenario for inspection.
 *
 * Reachable in dev at /__offscreen-spike__/visual-effects-sandbox.html.
 * Production builds never include this file (Vite's
 * `rollupOptions.input` only lists the main `index.html`).
 *
 * Iteration workflow:
 *   1. Designer opens this page.
 *   2. Picks an effect (today: Warp; later: Explosion / Beam / Thruster).
 *   3. Watches the loop; tunes params via sliders while it plays.
 *   4. When happy, hits "Copy params JSON" and pastes the values into
 *      `DEFAULT_WARP_PARAMS` in `worker/protocol.ts`.
 *
 * Adding a new effect later: extend the renderer + worker protocol with
 * the new API surface (e.g. `triggerExplosion(x, y)`), add a per-effect
 * scenario function here, and add a new `.effect-panel` + radio option
 * to the HTML.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  WorkerRendererClient,
  supportsOffscreenRenderer,
} from '../render/worker/WorkerRendererClient';
import {
  DEFAULT_WARP_PARAMS,
  type WarpParams,
} from '../render/worker/protocol';

// ---------- DOM refs ----------

const statusEl = document.getElementById('status') as HTMLDivElement;
const scenarioStatusEl = document.getElementById('scenario-status') as HTMLDivElement;
const canvasHost = document.getElementById('canvas-host') as HTMLDivElement;
const slidersHost = document.getElementById('warp-sliders') as HTMLDivElement;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setScenarioStatus(text: string): void {
  scenarioStatusEl.textContent = text;
}

// ---------- Slider config ----------

interface SliderSpec {
  key: keyof WarpParams;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

const WARP_SLIDERS: SliderSpec[] = [
  // Shared
  { key: 'speed',               label: 'speed',               min: 100,  max: 2000,  step: 25 },
  { key: 'wavelength',          label: 'wavelength',          min: 40,   max: 600,   step: 10 },
  { key: 'zoomBlurInnerRadius', label: 'blur innerRadius',    min: 0,    max: 400,   step: 10 },
  { key: 'fadeOutMs',           label: 'fadeOutMs',           min: 100,  max: 2000,  step: 50 },
  // Spool phase
  { key: 'spoolDurationMs',     label: 'spool: durationMs',   min: 0,    max: 8000,  step: 50 },
  { key: 'spoolCount',          label: 'spool: count',        min: 1,    max: 8,     step: 1 },
  { key: 'spoolWavePeriodMs',   label: 'spool: wavePeriodMs', min: 200,  max: 2000,  step: 50 },
  { key: 'spoolRadius',         label: 'spool: radius',       min: 50,   max: 800,   step: 10 },
  { key: 'spoolAmplitude',      label: 'spool: amplitude',    min: 0,    max: 80,    step: 1 },
  { key: 'spoolBrightness',     label: 'spool: brightness',   min: 1.0,  max: 2.0,   step: 0.02, format: (v) => v.toFixed(2) },
  { key: 'spoolZoomBlur',       label: 'spool: blur',         min: 0,    max: 1,     step: 0.02, format: (v) => v.toFixed(2) },
  // Climax phase
  { key: 'climaxDurationMs',    label: 'climax: durationMs',  min: 0,    max: 4000,  step: 50 },
  { key: 'climaxWavePeriodMs',  label: 'climax: wavePeriodMs',min: 1000, max: 10000, step: 100 },
  { key: 'climaxAmplitude',     label: 'climax: amplitude',   min: 10,   max: 250,   step: 5 },
  { key: 'climaxBrightness',    label: 'climax: brightness',  min: 1.0,  max: 2.5,   step: 0.02, format: (v) => v.toFixed(2) },
  { key: 'climaxZoomBlur',      label: 'climax: blur',        min: 0,    max: 1,     step: 0.02, format: (v) => v.toFixed(2) },
  // Burst + flash (exit moment + warp-in pulse)
  { key: 'burstDurationMs',     label: 'burst: durationMs',   min: 100,  max: 3000,  step: 50 },
  { key: 'burstAmplitude',      label: 'burst: amplitude',    min: 50,   max: 500,   step: 5 },
  { key: 'burstSpeed',          label: 'burst: speed',        min: 400,  max: 4000,  step: 50 },
  { key: 'burstWavelength',     label: 'burst: wavelength',   min: 80,   max: 800,   step: 10 },
  { key: 'burstBrightness',     label: 'burst: brightness',   min: 1.0,  max: 3.0,   step: 0.02, format: (v) => v.toFixed(2) },
  { key: 'flashAlphaMax',       label: 'flash: alphaMax',     min: 0,    max: 1,     step: 0.02, format: (v) => v.toFixed(2) },
  { key: 'flashDurationMs',     label: 'flash: durationMs',   min: 100,  max: 800,   step: 20 },
  { key: 'flashRangeMax',       label: 'flash: rangeMax (world)', min: 0, max: 8000, step: 100 },
  { key: 'bloomStrengthMax',    label: 'bloom: strengthMax',  min: 0,    max: 8,     step: 0.1, format: (v) => v.toFixed(1) },
];

// ---------- Renderer state ----------

let renderer: WorkerRendererClient | null = null;
const warpParams: WarpParams = { ...DEFAULT_WARP_PARAMS };

// ---------- Fullscreen + collapse plumbing ----------

interface DocLike extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}
interface ElLike extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

function getFullscreenElement(): Element | null {
  const d = document as DocLike;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

async function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement as ElLike;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!req) return false;
  try {
    await req.call(el);
  } catch {
    return false;
  }
  const orientation = (screen as Screen & {
    orientation?: { lock?: (o: string) => Promise<void> };
  }).orientation;
  if (orientation?.lock) {
    orientation.lock('landscape').catch(() => { /* not granted / not supported */ });
  }
  return true;
}

async function exitFullscreen(): Promise<void> {
  const orientation = (screen as Screen & {
    orientation?: { unlock?: () => void };
  }).orientation;
  try { orientation?.unlock?.(); } catch { /* not supported */ }
  const d = document as DocLike;
  const exit = d.exitFullscreen ?? d.webkitExitFullscreen;
  if (!exit) return;
  try { await exit.call(d); } catch { /* noop */ }
}

function refreshFullscreenIcon(): void {
  const btn = document.getElementById('fullscreen-toggle');
  if (!btn) return;
  btn.textContent = getFullscreenElement() !== null ? '⤢' : '⛶';
}

function setPanelCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('panel-collapsed', collapsed);
}

// ---------- Scenario mirror ----------

/**
 * Single-ship mirror for the warp scenario. No local-player follow —
 * the sandbox uses `setCameraCenter(0, 0)` at boot to anchor world
 * origin at screen centre, so the warper flies through screen space
 * without a follower-ship cluttering the frame.
 *
 * `warper.angle = -π/2` faces +x (right) because the renderer applies
 * `sprite.rotation = -ship.angle` and the polygon's nose is at -y.
 */
function buildScenarioMirror(): RenderMirror {
  return {
    ships: new Map([
      ['warper', { x: -700, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, kind: 'fighter', displayName: '' }],
    ]),
    swarm: new Map(),
    wrecks: new Map(),
    lingeringShips: new Map(),
    projectiles: new Map(),
    boostingShips: new Set(),
    thrustingShips: new Set(),
    explodingShips: new Set(),
    pendingDamageNumbers: [],
    pendingHealthBarHits: [],
    liveBeams: new Map(),
    localPlayerId: null,
  };
}

const mirror = buildScenarioMirror();

// ---------- Warp scenario state machine ----------

/**
 * Warp round-trip scenario timing (ms within one loop). Updated to
 * accommodate the wider 1500 ms burst (default) — exit + arrival
 * bursts must not overlap or the second would reset the first
 * mid-flight.
 *
 *   0      → 200   : ship visible at SHIP_START_X, no warp visual
 *   200    → 3950  : SPOOL (3750 ms) — small flutter ripples
 *   3950   → 5200  : CLIMAX (1250 ms) — big build-up pulse
 *   5200           : EXIT — burst+flash at SHIP_END_X, ship vanishes
 *   5200   → 6700  : warp-out fade + burst playing (ship gone)
 *   6700   → 7000  : TRAVEL (no ship, no warp visible)
 *   7000           : ARRIVAL — triggerWarpIn at SHIP_START_X
 *   7000   → 8500  : warp-in burst playing, ship visible
 *   8500   → 9000  : ship visible at SHIP_START_X
 *   9000           : loop restart
 */
const SCENARIO_LOOP_MS = 9000;
const SHIP_START_X = -700;
const SHIP_END_X = 700;
const SHIP_DRIFT_T0 = 200;
const EXIT_T = 5200;
const ARRIVAL_T = 7000;

let scenarioPlaying = true;
let scenarioT0 = performance.now();
type ScenarioWarpState = 'pre' | 'spool-climax' | 'exited' | 'arrived';
let scenarioWarpState: ScenarioWarpState = 'pre';

function startScenario(): void {
  scenarioPlaying = true;
  scenarioT0 = performance.now();
  scenarioWarpState = 'pre';
  // Reset warp centre back to whatever world-space the scenario chooses.
  renderer?.setWarpMode(false);
  setScenarioStatus('Looping: warp-out → travel → warp-in (round trip).');
}

function pauseScenarioForManual(): void {
  if (!scenarioPlaying) return;
  scenarioPlaying = false;
  renderer?.setWarpMode(false);
  scenarioWarpState = 'pre';
  // Move the warper off-screen so it doesn't clutter manual inspection.
  const w = mirror.ships.get('warper');
  if (w) w.x = -10000;
  setScenarioStatus('Loop paused (manual mode). Hit "Restart loop" to resume.');
}

function advanceScenario(phaseMs: number): void {
  const warper = mirror.ships.get('warper');
  if (!warper) return;

  // Reset the warp state machine at the start of each loop iteration —
  // `phaseMs` wraps from ~SCENARIO_LOOP_MS back to ~0 modulo, so on the
  // second pass we'd be stuck at 'arrived' and never re-enter spool.
  if (phaseMs < SHIP_DRIFT_T0 && scenarioWarpState !== 'pre') {
    scenarioWarpState = 'pre';
  }

  // ---- Ship position + visibility ----
  // Angle is set once in `buildScenarioMirror` and stays facing +x.
  if (phaseMs < SHIP_DRIFT_T0) {
    // Visible at start (post-loop arrival lingering or initial spawn).
    warper.x = SHIP_START_X;
  } else if (phaseMs < EXIT_T) {
    // Drift left → right with warp active.
    const t = (phaseMs - SHIP_DRIFT_T0) / (EXIT_T - SHIP_DRIFT_T0);
    warper.x = SHIP_START_X + (SHIP_END_X - SHIP_START_X) * t;
  } else if (phaseMs < ARRIVAL_T) {
    // Vanished — covered by flash during travel.
    warper.x = -10000;
  } else {
    // Re-appeared at the arrival point.
    warper.x = SHIP_START_X;
  }
  warper.y = 0;

  // ---- Warp state transitions ----
  // pre → spool-climax (at SHIP_DRIFT_T0): setWarpMode(true), centre on ship
  if (scenarioWarpState === 'pre' && phaseMs >= SHIP_DRIFT_T0 && phaseMs < EXIT_T) {
    renderer?.setWarpCenter({ kind: 'world', worldX: SHIP_START_X, worldY: 0 });
    renderer?.setWarpMode(true);
    scenarioWarpState = 'spool-climax';
  }
  // spool-climax → exited (at EXIT_T): setWarpMode(false) fires burst+flash
  if (scenarioWarpState === 'spool-climax' && phaseMs >= EXIT_T) {
    // Centre is still on the ship's last position (SHIP_END_X) — the
    // burst emanates from where the ship vanished.
    renderer?.setWarpCenter({ kind: 'world', worldX: SHIP_END_X, worldY: 0 });
    renderer?.setWarpMode(false);
    scenarioWarpState = 'exited';
  }
  // exited → arrived (at ARRIVAL_T): triggerWarpIn at the spawn point
  if (scenarioWarpState === 'exited' && phaseMs >= ARRIVAL_T) {
    renderer?.triggerWarpIn({ kind: 'world', worldX: SHIP_START_X, worldY: 0 });
    scenarioWarpState = 'arrived';
  }

  // ---- Per-frame centre tracking during the warp-out drift ----
  if (scenarioWarpState === 'spool-climax') {
    renderer?.setWarpCenter({ kind: 'world', worldX: warper.x, worldY: warper.y });
  }
}

// ---------- Sliders ----------

function buildSliders(): void {
  slidersHost.innerHTML = '';
  for (const spec of WARP_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const label = document.createElement('label');
    label.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(warpParams[spec.key]);

    const valueEl = document.createElement('span');
    valueEl.className = 'value';
    const fmt = spec.format ?? ((v: number) => String(v));
    valueEl.textContent = fmt(warpParams[spec.key]);

    input.addEventListener('input', () => {
      const num = Number(input.value);
      Object.assign(warpParams, { [spec.key]: num });
      valueEl.textContent = fmt(num);
      renderer?.setWarpParams({ [spec.key]: num } as Partial<WarpParams>);
    });

    row.append(label, input, valueEl);
    slidersHost.append(row);
  }
}

function resetWarpParams(): void {
  Object.assign(warpParams, DEFAULT_WARP_PARAMS);
  buildSliders();
  renderer?.setWarpParams({ ...DEFAULT_WARP_PARAMS });
  setStatus('Params reset to defaults.');
}

// ---------- Recentre + auto-recenter on layout changes ----------

const followToggle = (): HTMLInputElement | null =>
  document.getElementById('follow-ship') as HTMLInputElement | null;

function recentreCamera(): void {
  // In Follow mode the renderer's per-tick camera follow re-centres on
  // the warper automatically, so this is a no-op there. In observer
  // mode (the default) we explicitly re-place world (0, 0) at screen
  // centre — necessary after resize / orientation / fullscreen toggles
  // because `Camera.target.x/y` was computed against the old screen
  // dims.
  if (!followToggle()?.checked) {
    renderer?.setCameraCenter(0, 0);
  }
}

// ---------- Main ----------

async function main(): Promise<void> {
  // Wire fullscreen + collapse FIRST so they work even if renderer boot fails.
  document.getElementById('fullscreen-toggle')?.addEventListener('click', () => {
    if (getFullscreenElement() !== null) {
      void exitFullscreen();
    } else {
      void enterFullscreen().then((ok) => {
        if (!ok) setStatus('Fullscreen API not available in this browser.', true);
      });
    }
  });
  document.addEventListener('fullscreenchange', refreshFullscreenIcon);
  document.addEventListener('webkitfullscreenchange', refreshFullscreenIcon);
  refreshFullscreenIcon();

  document.getElementById('close-panel')?.addEventListener('click', () => setPanelCollapsed(true));
  document.getElementById('open-panel')?.addEventListener('click', () => setPanelCollapsed(false));

  if (!supportsOffscreenRenderer()) {
    setStatus(
      'This browser lacks OffscreenCanvas — the sandbox needs the worker renderer to exercise filter-in-worker constraints. Try Chrome/Firefox/Edge.',
      true,
    );
    return;
  }

  setStatus('Booting renderer (worker)…');
  renderer = new WorkerRendererClient();
  try {
    await renderer.init(canvasHost);
  } catch (err) {
    setStatus(
      `Renderer init failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
    return;
  }
  setStatus('Renderer ready. Loop running — tune params with sliders.');

  // Anchor world (0, 0) at screen centre — the sandbox has no local
  // player ship to follow, so the camera is positioned explicitly.
  renderer.setCameraCenter(0, 0);

  // Per-frame loop: advance the scenario (if playing) and push the
  // mirror to the worker.
  const tickFrame = (): void => {
    if (scenarioPlaying) {
      const phase = (performance.now() - scenarioT0) % SCENARIO_LOOP_MS;
      advanceScenario(phase);
    }
    renderer?.update(mirror);
  };
  tickFrame();
  window.setInterval(tickFrame, 16);

  buildSliders();
  startScenario();

  document.getElementById('scenario-restart')?.addEventListener('click', () => {
    startScenario();
    setStatus('Scenario restarted.');
  });

  // Camera POV toggle. Unchecked = observer (camera anchored at world
  // origin); checked = follow the warper (ship's POV — the world flows
  // past while the ship stays at screen centre).
  const followToggle = document.getElementById('follow-ship') as HTMLInputElement | null;
  followToggle?.addEventListener('change', () => {
    if (followToggle.checked) {
      mirror.localPlayerId = 'warper';
      setStatus('Camera follows warper (ship POV).');
    } else {
      mirror.localPlayerId = null;
      renderer?.setCameraCenter(0, 0);
      setStatus('Camera observer mode (world origin centred).');
    }
  });

  // Manual override hooks. Each one pauses the scenario and lets the
  // user inspect the effect in a frozen frame of reference.
  document.getElementById('warp-on')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.setWarpMode(true);
    setStatus('Warp ON (manual). Click OFF to fade out.');
  });
  document.getElementById('warp-off')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.setWarpMode(false);
    setStatus('Warp OFF (manual).');
  });

  document.getElementById('warp-in-trigger')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.triggerWarpIn({ kind: 'world', worldX: 0, worldY: 0 });
    setStatus('Warp-IN burst fired at world (0, 0).');
  });

  document.getElementById('recentre')?.addEventListener('click', () => {
    renderer?.setCameraCenter(0, 0);
    setStatus('Camera recentred on world (0, 0).');
  });

  // Auto-recentre on layout changes — fullscreen toggle, orientation
  // flip, and visual-viewport resize on mobile. Without this the camera
  // stays anchored at the old screen-space target after the canvas
  // dimensions change, so the action drifts off-centre.
  const autoRecentre = (): void => {
    // Defer one frame so the renderer has handled its own resize first.
    requestAnimationFrame(() => recentreCamera());
  };
  window.addEventListener('resize', autoRecentre);
  window.addEventListener('orientationchange', autoRecentre);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', autoRecentre);
  }
  document.addEventListener('fullscreenchange', autoRecentre);
  document.addEventListener('webkitfullscreenchange', autoRecentre);

  document.getElementById('warp-reset')?.addEventListener('click', resetWarpParams);
  document.getElementById('warp-copy')?.addEventListener('click', () => {
    const json = JSON.stringify(warpParams, null, 2);
    void navigator.clipboard?.writeText(json).then(
      () => setStatus('Copied current params JSON to clipboard.'),
      (err: unknown) => {
        setStatus(
          `Clipboard write failed: ${err instanceof Error ? err.message : String(err)} — params logged below.`,
          true,
        );
        console.log('warp params:', json);
      },
    );
  });

  // ── M10 (plan wiggly-puppy): radio-driven per-effect scenarios ─────

  // Effect-picker radio change → swap visible panel + scenario.
  const panels = ['warp', 'explosion', 'impact', 'shield', 'thruster'];
  for (const p of panels) {
    document.getElementById(`effect-${p}`)?.addEventListener('change', () => {
      for (const q of panels) {
        const panel = document.getElementById(`${q}-panel`);
        if (panel) panel.classList.toggle('active', q === p);
      }
      setStatus(`Switched to effect: ${p}.`);
    });
  }

  // Quality dropdown — pushes via SET_EFFECT_QUALITY through the worker
  // protocol. The budget keeps the more-restrictive of (local, pushed).
  const qualityEl = document.getElementById('effect-quality') as HTMLSelectElement | null;
  qualityEl?.addEventListener('change', () => {
    const level = qualityEl.value as 'high' | 'medium' | 'low' | 'minimal';
    renderer?.setEffectQuality(level);
    setStatus(`Effect quality pushed: ${level}.`);
  });

  // Explosion trigger — fires both destruction burst + shockwave.
  document.getElementById('explosion-trigger')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.triggerEffect('destruction', 0, 0);
    renderer?.triggerEffect('destruction-shock', 0, 0);
    setStatus('Explosion triggered at world (0, 0).');
  });

  // Impact spark triggers — hull vs shield tints.
  document.getElementById('impact-hull')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.triggerEffect('impact', 0, 0, { tint: 0xff8844 });
    setStatus('Hull-hit impact at (0, 0).');
  });
  document.getElementById('impact-shield')?.addEventListener('click', () => {
    pauseScenarioForManual();
    renderer?.triggerEffect('impact', 0, 0, { tint: 0x88ddff });
    setStatus('Shield-hit impact at (0, 0).');
  });
  let impactLoopId: number | null = null;
  document.getElementById('impact-loop')?.addEventListener('click', () => {
    pauseScenarioForManual();
    if (impactLoopId !== null) {
      clearInterval(impactLoopId);
      impactLoopId = null;
      setStatus('Impact loop OFF.');
      return;
    }
    impactLoopId = setInterval(() => {
      const x = (Math.random() - 0.5) * 200;
      const y = (Math.random() - 0.5) * 200;
      renderer?.triggerEffect('impact', x, y, {
        tint: Math.random() < 0.5 ? 0xff8844 : 0x88ddff,
      });
    }, 220) as unknown as number;
    setStatus('Impact loop ON (every 220 ms).');
  });

  // Shield aura — relies on EffectsService.setContinuous via the worker.
  // For the sandbox we use the trigger pathway as a proxy: writing
  // mirror.shipShields would need a real ship in the mirror, so use the
  // visual-effects-only path (a single "ship" entry with the local pose).
  document.getElementById('shield-on')?.addEventListener('click', () => {
    pauseScenarioForManual();
    if (mirror.ships) {
      mirror.ships.set('sandbox-ship', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, shieldDown: false });
      mirror.localPlayerId = 'sandbox-ship';
    }
    setStatus('Shield ON (mirror entry created with shieldDown=false).');
  });
  document.getElementById('shield-off')?.addEventListener('click', () => {
    pauseScenarioForManual();
    if (mirror.ships) {
      const s = mirror.ships.get('sandbox-ship');
      if (s) s.shieldDown = true;
    }
    setStatus('Shield OFF (shieldDown=true).');
  });
  document.getElementById('shield-pulse')?.addEventListener('click', () => {
    pauseScenarioForManual();
    // Trigger via impact channel; renderer's pulse hook fires when the
    // tint matches shield (0x88ddff) AND entityId is set.
    if (!mirror.pendingEffectTriggers) mirror.pendingEffectTriggers = [];
    mirror.pendingEffectTriggers.push({
      kind: 'impact',
      worldX: 0,
      worldY: 0,
      tint: 0x88ddff,
      entityId: 'sandbox-ship',
    });
    setStatus('Shield pulse queued.');
  });

  // Thrust + boost — populate mirror.thrustingShips / boostingShips for
  // the sandbox ship; PixiRenderer's syncEngineContinuousEffects diff
  // logic picks them up.
  function ensureSandboxShip(): void {
    if (mirror.ships && !mirror.ships.has('sandbox-ship')) {
      mirror.ships.set('sandbox-ship', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
      mirror.localPlayerId = 'sandbox-ship';
    }
  }
  document.getElementById('thrust-on')?.addEventListener('click', () => {
    pauseScenarioForManual();
    ensureSandboxShip();
    if (!mirror.thrustingShips) mirror.thrustingShips = new Set();
    mirror.thrustingShips.add('sandbox-ship');
    setStatus('Thrust ON for sandbox ship.');
  });
  document.getElementById('thrust-off')?.addEventListener('click', () => {
    pauseScenarioForManual();
    mirror.thrustingShips?.delete('sandbox-ship');
    setStatus('Thrust OFF.');
  });
  document.getElementById('boost-on')?.addEventListener('click', () => {
    pauseScenarioForManual();
    ensureSandboxShip();
    if (!mirror.boostingShips) mirror.boostingShips = new Set();
    mirror.boostingShips.add('sandbox-ship');
    setStatus('Boost ON for sandbox ship.');
  });
  document.getElementById('boost-off')?.addEventListener('click', () => {
    pauseScenarioForManual();
    mirror.boostingShips?.delete('sandbox-ship');
    setStatus('Boost OFF.');
  });
}

window.addEventListener('error', (e: ErrorEvent) => {
  setStatus(`[uncaught] ${e.message}`, true);
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  setStatus(`[unhandled] ${String(e.reason)}`, true);
});

void main();
