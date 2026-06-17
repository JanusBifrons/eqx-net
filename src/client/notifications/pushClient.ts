/**
 * Client-side Web Push helper: capability detection + subscribe / unsubscribe.
 *
 * The service worker that receives push events is registered by vite-plugin-pwa
 * (production only — see main.tsx). This module talks to the server's `/push`
 * routes: it fetches the VAPID public key, asks the browser to subscribe, and
 * POSTs the resulting PushSubscription (with the user's bearer token).
 *
 * iOS reality: Web Push only works inside an INSTALLED (home-screen) PWA, so a
 * logged-in iOS-Safari tab is shown the "Add to Home Screen" hint instead of a
 * toggle that can't function — see `shouldOfferPushToggle`.
 */

export interface PushEnvironment {
  /** serviceWorker + PushManager + Notification all present. */
  supported: boolean;
  /** iOS / iPadOS (incl. iPadOS-on-desktop-UA). */
  isIos: boolean;
  /** Running as an installed (standalone) PWA. */
  isStandalone: boolean;
}

export function detectPushEnvironment(): PushEnvironment {
  const hasNav = typeof navigator !== 'undefined';
  const hasWin = typeof window !== 'undefined';
  const supported =
    hasNav && 'serviceWorker' in navigator && hasWin && 'PushManager' in window && 'Notification' in window;

  const ua = hasNav ? navigator.userAgent : '';
  const maxTouch = hasNav ? (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0 : 0;
  // iPadOS 13+ reports a desktop Safari UA; the touch-point count disambiguates.
  const isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouch > 1);

  const standaloneMedia = hasWin && typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false;
  const iosStandalone = hasNav && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const isStandalone = standaloneMedia || iosStandalone;

  return { supported, isIos, isStandalone };
}

/**
 * Pure decision: should the working push toggle be offered? On iOS, push only
 * works once installed, so an un-installed iOS tab gets the install hint, not a
 * dead toggle. Everywhere else, support is sufficient.
 */
export function shouldOfferPushToggle(env: PushEnvironment): boolean {
  if (!env.supported) return false;
  if (env.isIos && !env.isStandalone) return false;
  return true;
}

/** VAPID keys are URL-safe base64; the browser needs the raw bytes. The return
 *  is explicitly `ArrayBuffer`-backed (not the default `ArrayBufferLike`) so it
 *  satisfies `applicationServerKey: BufferSource` under TS 5.7's stricter
 *  typed-array generics. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  // getRegistration() resolves immediately (vs `.ready`, which never resolves
  // when no SW is registered — e.g. dev / Playwright).
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ?? null;
}

/** True if this browser currently holds a push subscription. */
export async function getPushSubscribed(): Promise<boolean> {
  const reg = await activeRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return sub !== null;
}

export type SubscribeReason = 'ok' | 'no-sw' | 'denied' | 'server-disabled' | 'server-rejected';

/** Request permission, subscribe, and register the subscription with the server. */
export async function subscribeToPush(token: string): Promise<{ ok: boolean; reason: SubscribeReason }> {
  const reg = await activeRegistration();
  if (!reg) return { ok: false, reason: 'no-sw' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const keyRes = await fetch('/push/vapid-public-key');
  const { publicKey, enabled } = (await keyRes.json()) as { publicKey: string; enabled: boolean };
  if (!enabled || !publicKey) return { ok: false, reason: 'server-disabled' };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = sub.toJSON();
  const res = await fetch('/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!res.ok) return { ok: false, reason: 'server-rejected' };
  return { ok: true, reason: 'ok' };
}

/** Unsubscribe locally and tell the server to drop the endpoint. */
export async function unsubscribeFromPush(token: string): Promise<void> {
  const reg = await activeRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await fetch('/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}
