/**
 * Page-lifecycle + connection-state listeners.
 *
 * plan: imperative-taco-r2 evidence pass — Q1 distinguishes "phone-side
 * throttle" (CPU/GPU) from "page-state throttle" (browser parks the page
 * because it's hidden / backgrounded / discarded). And the connection
 * `change` event fires when the WiFi state shifts (rtt/downlink update,
 * effectiveType change). Both are needed to interpret an `effectiveHz`
 * drop: a 90 → 30 Hz drop while `document.visibilityState === 'hidden'`
 * is "user backgrounded the page", not thermal throttle. A drop with no
 * lifecycle event is the throttle hypothesis.
 *
 * Discrete low-frequency events — install once at bootstrap; no per-frame
 * cost. Pure module.
 */
import { logEvent } from './ClientLogger.js';

interface NetInfoLike {
  rtt?: number;
  downlink?: number;
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
}

let installed = false;

/**
 * Register listeners for `document.visibilitychange`, lifecycle freeze /
 * resume (Page Lifecycle API), and `navigator.connection.change`. Each
 * fires a discrete `lifecycle_event` log entry the diag capture can
 * correlate with `effectiveHz` / `recv_gap_long`. Idempotent.
 */
export function installPageLifecycleObserver(): void {
  if (installed) return;
  installed = true;

  if (typeof document !== 'undefined') {
    // visibilitychange — fires when user tabs away, screen locks, or
    // backgrounds the app. Hidden state means the browser will throttle
    // rAF to ~1 Hz and may suspend WS callbacks.
    document.addEventListener('visibilitychange', () => {
      logEvent('lifecycle_event', {
        kind: 'visibilitychange',
        visibilityState: document.visibilityState,
        hidden: document.hidden,
      });
    });

    // Page Lifecycle API — `freeze` fires when the browser puts the
    // page into a low-power state without unloading; `resume` fires
    // when it returns. iOS Safari fires these aggressively when the
    // user swipes away the app; Android Chrome fires them more
    // selectively. NOT supported in all browsers; we attach without
    // the feature check (the listener just doesn't fire if unsupported).
    document.addEventListener('freeze', () => {
      logEvent('lifecycle_event', { kind: 'freeze' });
    });
    document.addEventListener('resume', () => {
      logEvent('lifecycle_event', { kind: 'resume' });
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      logEvent('lifecycle_event', { kind: 'pagehide' });
    });
    window.addEventListener('pageshow', () => {
      logEvent('lifecycle_event', { kind: 'pageshow' });
    });
  }

  // navigator.connection.change — fires when the browser detects a
  // network condition change (WiFi → cellular, RTT change, downlink
  // change). This is the "did the WiFi degrade mid-session" signal.
  // Different browsers expose this differently; we feature-detect.
  if (typeof navigator !== 'undefined') {
    const conn = (navigator as { connection?: NetInfoLike }).connection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', () => {
        logEvent('lifecycle_event', {
          kind: 'connection_change',
          rtt: typeof conn.rtt === 'number' ? conn.rtt : null,
          downlink: typeof conn.downlink === 'number' ? conn.downlink : null,
          effectiveType: conn.effectiveType ?? null,
          saveData: typeof conn.saveData === 'boolean' ? conn.saveData : null,
        });
      });
    }
  }

  // Snapshot the initial state immediately so the capture's first
  // event after boot has a baseline to compare against.
  if (typeof document !== 'undefined') {
    logEvent('lifecycle_event', {
      kind: 'initial',
      visibilityState: document.visibilityState,
      hidden: document.hidden,
    });
  }
}

/** Test-only: reset the install latch. */
export function _resetPageLifecycleObserverForTests(): void {
  installed = false;
}
