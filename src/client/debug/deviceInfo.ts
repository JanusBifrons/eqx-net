/**
 * Probe 2 — device fingerprint + native refresh-rate calibration.
 *
 * Built in response to the 2026-05-24 mg5rpe / 3vzz3q captures showing a
 * 22 ms rAF cadence on a Pixel 6 (Mali-G78, Android 16, Chrome 148) where
 * 60/90 Hz is the panel's spec. The 45 fps effective rate is Chrome
 * software-throttling rAF, NOT a hardware limit. This module captures
 * everything needed to disambiguate which decision-axis is responsible.
 *
 * Emits exactly one `device_info` event at session start with a snapshot
 * of every accessible device/browser capability + state field, plus a
 * calibrated rAF cadence measured over a short window (~660 ms) BEFORE
 * the game starts so the measurement is uncontaminated by game work.
 *
 * No async APIs are awaited that aren't strictly necessary — the goal is
 * to fire `device_info` as early as possible so it's in every capture
 * regardless of session length. The battery API is best-effort; if it
 * resolves quickly the value is included, otherwise it lands on disk
 * unknown and the user runs another capture if needed.
 */

import { logEvent } from './ClientLogger';

interface NavigatorWithExtras extends Navigator {
  deviceMemory?: number;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
  getBattery?: () => Promise<{ charging: boolean; level: number }>;
}

interface ScreenWithRefreshRate extends Screen {
  refreshRate?: number;
}

/**
 * Synchronous device fingerprint. Captures everything readable without
 * a Promise round-trip, so it's safe to call at module-top.
 */
function gatherSyncFingerprint(): Record<string, unknown> {
  const nav = navigator as NavigatorWithExtras;
  const scr = screen as ScreenWithRefreshRate;
  const conn = nav.connection;

  return {
    // Browser + OS identity
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages ? Array.from(navigator.languages) : [],
    vendor: navigator.vendor,

    // Hardware capability hints
    deviceMemory: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    maxTouchPoints: navigator.maxTouchPoints ?? null,

    // Display
    screenWidth: screen.width,
    screenHeight: screen.height,
    screenColorDepth: screen.colorDepth,
    devicePixelRatio: window.devicePixelRatio,
    screenRefreshRate: scr.refreshRate ?? null,
    orientation: screen.orientation?.type ?? null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualViewportScale: window.visualViewport?.scale ?? null,

    // Display mode (PWA vs browser)
    isStandalone: window.matchMedia('(display-mode: standalone)').matches,
    isFullscreen: window.matchMedia('(display-mode: fullscreen)').matches,
    isMinimalUI: window.matchMedia('(display-mode: minimal-ui)').matches,

    // Network
    connectionEffectiveType: conn?.effectiveType ?? null,
    connectionDownlink: conn?.downlink ?? null,
    connectionRtt: conn?.rtt ?? null,
    connectionSaveData: conn?.saveData ?? null,

    // Accessibility / system preferences that affect rendering
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    prefersColorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',

    // WebGL / canvas (best-effort — these can fail silently)
    webglVendor: getWebglInfo('vendor'),
    webglRenderer: getWebglInfo('renderer'),

    // Timing reference
    capturedAtPerfNow: performance.now(),
  };
}

function getWebglInfo(field: 'vendor' | 'renderer'): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const debug = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!debug) return null;
    const param = field === 'vendor'
      ? (debug as { UNMASKED_VENDOR_WEBGL: number }).UNMASKED_VENDOR_WEBGL
      : (debug as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL;
    return String((gl as WebGLRenderingContext).getParameter(param));
  } catch {
    return null;
  }
}

/**
 * Measure the actual rAF cadence over `frames` callbacks. Returns the
 * median inter-frame interval in ms. ~660 ms total wall-clock at 60 Hz
 * (40 frames × 16.67 ms) — short enough to not delay any meaningful
 * gameplay but long enough that one bad sample doesn't dominate the
 * median.
 *
 * This is the load-bearing measurement: if the median is 11.1 ms, the
 * panel is genuinely 90 Hz. If 16.7 ms → 60 Hz. If 22 ms → 45 Hz
 * effective (chrome throttle, since Pixel 6 doesn't ship a 45 Hz panel).
 * If 33 ms → 30 Hz throttle. The number we get DIRECTLY indicates which
 * decision axis is in play.
 */
async function calibrateRefreshRate(frames = 40): Promise<{
  medianIntervalMs: number;
  effectiveHz: number;
  sampleCount: number;
}> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    let lastTime = -1;
    let count = 0;

    function tick(now: number): void {
      if (lastTime > 0) {
        samples.push(now - lastTime);
      }
      lastTime = now;
      count++;
      if (count <= frames) {
        requestAnimationFrame(tick);
      } else {
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        resolve({
          medianIntervalMs: parseFloat(median.toFixed(2)),
          effectiveHz: parseFloat((1000 / median).toFixed(1)),
          sampleCount: samples.length,
        });
      }
    }
    requestAnimationFrame(tick);
  });
}

/**
 * Run the full device-info capture. Fires `device_info` immediately with
 * sync fields, then after the rAF calibration completes (~660 ms), fires
 * `device_info_calibration` with the measured cadence. Two events because
 * the calibration takes time and we don't want to delay the sync fields
 * in case the session aborts early.
 *
 * The Battery API is queried fire-and-forget after both — if it resolves
 * within 2 s its data lands on a third `device_battery` event; otherwise
 * the absence on disk is itself a data point.
 */
export function captureDeviceInfo(): void {
  const fingerprint = gatherSyncFingerprint();
  logEvent('device_info', fingerprint);

  // Calibration runs async so it doesn't block the rest of bootup.
  void calibrateRefreshRate().then((cal) => {
    logEvent('device_info_calibration', cal);
  });

  // Battery is best-effort.
  const nav = navigator as NavigatorWithExtras;
  if (typeof nav.getBattery === 'function') {
    const timeout = window.setTimeout(() => {
      logEvent('device_battery', { available: false, reason: 'timeout' });
    }, 2000);
    nav.getBattery().then((bat) => {
      window.clearTimeout(timeout);
      logEvent('device_battery', {
        available: true,
        charging: bat.charging,
        level: parseFloat(bat.level.toFixed(2)),
      });
    }).catch((e: unknown) => {
      window.clearTimeout(timeout);
      logEvent('device_battery', { available: false, reason: String(e) });
    });
  } else {
    logEvent('device_battery', { available: false, reason: 'no_api' });
  }
}
