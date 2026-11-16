/**
 * Visual-effects test harness — boots the production
 * `WorkerRendererClient` with no networking, and drives the renderer's
 * effect APIs from per-effect buttons.
 *
 * Reachable in dev at /__offscreen-spike__/visual-effects-sandbox.html.
 * Production builds never include this file (Vite's
 * `rollupOptions.input` only lists the main `index.html`).
 *
 * Adding a new effect later: add a per-effect panel + radio option to
 * the HTML and wire its buttons here.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  WorkerRendererClient,
  supportsOffscreenRenderer,
} from '../render/worker/WorkerRendererClient';

// ---------- DOM refs ----------

const statusEl = document.getElementById('status') as HTMLDivElement;
const canvasHost = document.getElementById('canvas-host') as HTMLDivElement;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// ---------- Renderer state ----------

let renderer: WorkerRendererClient | null = null;

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

// ---------- Sandbox mirror ----------

/** Empty mirror; the effect buttons add the entries they need. */
function buildSandboxMirror(): RenderMirror {
  return {
    ships: new Map(),
    swarm: new Map(),
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

const mirror = buildSandboxMirror();

// ---------- Recentre + auto-recenter on layout changes ----------

function recentreCamera(): void {
  // Re-place world (0, 0) at screen centre — necessary after resize /
  // orientation / fullscreen toggles because `Camera.target.x/y` was
  // computed against the old screen dims.
  renderer?.setCameraCenter(0, 0);
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
  setStatus('Renderer ready. Pick an effect.');

  // Anchor world (0, 0) at screen centre — the sandbox has no local
  // player ship to follow, so the camera is positioned explicitly.
  renderer.setCameraCenter(0, 0);

  // Per-frame loop: push the mirror to the worker.
  const tickFrame = (): void => {
    renderer?.update(mirror);
  };
  tickFrame();
  window.setInterval(tickFrame, 16);

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

  // ── M10 (plan wiggly-puppy): radio-driven per-effect scenarios ─────

  // Effect-picker radio change → swap visible panel + scenario.
  const panels = ['explosion', 'impact', 'shield', 'thruster'];
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
    renderer?.triggerEffect('destruction', 0, 0);
    renderer?.triggerEffect('destruction-shock', 0, 0);
    setStatus('Explosion triggered at world (0, 0).');
  });

  // Impact spark triggers — hull vs shield tints.
  document.getElementById('impact-hull')?.addEventListener('click', () => {
    renderer?.triggerEffect('impact', 0, 0, { tint: 0xff8844 });
    setStatus('Hull-hit impact at (0, 0).');
  });
  document.getElementById('impact-shield')?.addEventListener('click', () => {
    renderer?.triggerEffect('impact', 0, 0, { tint: 0x88ddff });
    setStatus('Shield-hit impact at (0, 0).');
  });
  let impactLoopId: number | null = null;
  document.getElementById('impact-loop')?.addEventListener('click', () => {
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
    if (mirror.ships) {
      mirror.ships.set('sandbox-ship', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, shieldDown: false });
      mirror.localPlayerId = 'sandbox-ship';
    }
    setStatus('Shield ON (mirror entry created with shieldDown=false).');
  });
  document.getElementById('shield-off')?.addEventListener('click', () => {
    if (mirror.ships) {
      const s = mirror.ships.get('sandbox-ship');
      if (s) s.shieldDown = true;
    }
    setStatus('Shield OFF (shieldDown=true).');
  });
  document.getElementById('shield-pulse')?.addEventListener('click', () => {
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
    ensureSandboxShip();
    if (!mirror.thrustingShips) mirror.thrustingShips = new Set();
    mirror.thrustingShips.add('sandbox-ship');
    setStatus('Thrust ON for sandbox ship.');
  });
  document.getElementById('thrust-off')?.addEventListener('click', () => {
    mirror.thrustingShips?.delete('sandbox-ship');
    setStatus('Thrust OFF.');
  });
  document.getElementById('boost-on')?.addEventListener('click', () => {
    ensureSandboxShip();
    if (!mirror.boostingShips) mirror.boostingShips = new Set();
    mirror.boostingShips.add('sandbox-ship');
    setStatus('Boost ON for sandbox ship.');
  });
  document.getElementById('boost-off')?.addEventListener('click', () => {
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
