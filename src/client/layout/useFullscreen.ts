import { useCallback, useEffect, useState } from 'react';

type LockOrientation = (orientation: string) => Promise<void>;
type UnlockOrientation = () => void;

interface DocLike extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}

interface ElLike extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

/**
 * Best-effort landscape lock. Browsers grant it only in full screen or in an
 * installed app (Android); iOS has no lock API, so it does nothing there and
 * `RotatePhoneOverlay` asks the player to turn the phone instead.
 */
export function lockLandscape(): void {
  const orientation = (screen as Screen & { orientation?: { lock?: LockOrientation } }).orientation;
  if (!orientation?.lock) return;
  orientation.lock('landscape').catch(() => { /* not granted / not supported */ });
}

function getFullscreenElement(): Element | null {
  const d = document as DocLike;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * Tracks the document's fullscreen state and exposes a best-effort
 * `enterFullscreen()` that also attempts a landscape orientation lock.
 *
 * - **Android Chrome / Edge / Firefox**: `requestFullscreen()` removes the
 *   URL bar, returns a resolved promise.
 * - **iOS Safari**: no fullscreen API for HTML pages — the promise rejects
 *   silently. The only way to remove iOS Safari's chrome is the user
 *   installing the PWA via "Add to Home Screen". `enterFullscreen` returns
 *   `false` in that case so callers can show an install hint.
 */
export function useFullscreen(): {
  isFullscreen: boolean;
  enterFullscreen: () => Promise<boolean>;
  exitFullscreen: () => Promise<void>;
} {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() => getFullscreenElement() !== null);

  useEffect(() => {
    const handler = (): void => setIsFullscreen(getFullscreenElement() !== null);
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  const enterFullscreen = useCallback(async (): Promise<boolean> => {
    const el = document.documentElement as ElLike;
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (!req) return false;
    try {
      await req.call(el);
    } catch {
      return false;
    }
    lockLandscape();
    return true;
  }, []);

  const exitFullscreen = useCallback(async (): Promise<void> => {
    // Release the landscape lock first so the device can swing back to
    // whatever orientation it physically is. Otherwise on Android the lock
    // outlives fullscreen and the page stays sideways.
    const orientation = (screen as Screen & {
      orientation?: { unlock?: UnlockOrientation };
    }).orientation;
    try { orientation?.unlock?.(); } catch { /* not supported */ }

    const d = document as DocLike;
    const exit = d.exitFullscreen ?? d.webkitExitFullscreen;
    if (!exit) return;
    try { await exit.call(d); } catch { /* noop */ }
  }, []);

  return { isFullscreen, enterFullscreen, exitFullscreen };
}
