/**
 * Web Push transport — thin wrapper over the `web-push` library + VAPID config.
 *
 * VAPID keys come from the environment (`EQX_VAPID_PUBLIC_KEY` /
 * `EQX_VAPID_PRIVATE_KEY`; generate with `npx web-push generate-vapid-keys`).
 * When they're absent push is DISABLED (a single warning, no throw) — a missing
 * key is not a security hole, it just means no notifications, so we never take
 * the game server down over it. The public key is also served to the client at
 * `GET /push/vapid-public-key`. See docs/architecture/web-push.md.
 */
import webpush from 'web-push';
import { pino } from 'pino';

const log = pino({ name: 'push' });

const publicKey = process.env['EQX_VAPID_PUBLIC_KEY'] ?? '';
const privateKey = process.env['EQX_VAPID_PRIVATE_KEY'] ?? '';
const subject = process.env['EQX_VAPID_SUBJECT'] ?? 'mailto:admin@eqx-peri.local';

/** True only when both VAPID keys are configured. */
export const pushEnabled: boolean = Boolean(publicKey && privateKey);

/** The VAPID public (application server) key the client subscribes with. */
export const vapidPublicKey: string = publicKey;

if (pushEnabled) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  log.info('Web Push enabled (VAPID configured)');
} else {
  log.warn(
    'Web Push DISABLED — set EQX_VAPID_PUBLIC_KEY + EQX_VAPID_PRIVATE_KEY ' +
      '(generate with `npx web-push generate-vapid-keys`) to enable base-attack notifications.',
  );
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  /** The push service accepted the message. */
  ok: boolean;
  /** The endpoint is gone (HTTP 404/410) — the caller should prune it. */
  gone: boolean;
}

/**
 * Send one push payload to one subscription. Never throws — failures are
 * returned as `{ ok:false }`, with `gone:true` when the endpoint has expired or
 * the user unsubscribed (so the caller prunes it from the DB).
 */
export async function sendWebPush(target: PushTarget, payloadJson: string): Promise<SendResult> {
  if (!pushEnabled) return { ok: false, gone: false };
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payloadJson,
    );
    return { ok: true, gone: false };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const gone = statusCode === 404 || statusCode === 410;
    if (!gone) log.warn({ statusCode }, 'web push send failed');
    return { ok: false, gone };
  }
}
