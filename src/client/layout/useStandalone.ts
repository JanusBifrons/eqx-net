import { useEffect, useState } from 'react';

/**
 * True when the page is running as an installed PWA (no browser chrome).
 *
 * - iOS Safari: `window.navigator.standalone === true` after Add-to-Home-Screen.
 * - Android Chrome / Edge: `display-mode: standalone` (or `fullscreen`) media
 *   query matches when launched from a home-screen icon with the manifest's
 *   `display: fullscreen` / `standalone` setting.
 */
export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const iosStandalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const cssStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches;
    return iosStandalone || cssStandalone;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mqs = [
      window.matchMedia('(display-mode: standalone)'),
      window.matchMedia('(display-mode: fullscreen)'),
    ];
    const handler = (): void => {
      const iosStandalone =
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
      const cssStandalone = mqs.some((mq) => mq.matches);
      setStandalone(iosStandalone || cssStandalone);
    };
    mqs.forEach((mq) => mq.addEventListener('change', handler));
    return () => mqs.forEach((mq) => mq.removeEventListener('change', handler));
  }, []);

  return standalone;
}

/** True when the device is iOS Safari (so the standalone install path = "Add to Home Screen"). */
export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iPad on iOS 13+ reports "Macintosh" UA — disambiguate by maxTouchPoints.
  const isIPadOS =
    /Macintosh/.test(ua) && (window.navigator.maxTouchPoints ?? 0) > 1;
  return /iPhone|iPod|iPad/.test(ua) || isIPadOS;
}
