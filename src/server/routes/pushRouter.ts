/**
 * Web Push HTTP routes (mounted at `/push` in src/server/index.ts):
 *   GET  /push/vapid-public-key  — the VAPID application-server key the client
 *                                  subscribes with (+ whether push is enabled).
 *   POST /push/subscribe         — store a PushSubscription for the authed user.
 *   POST /push/unsubscribe       — remove a subscription by endpoint.
 *
 * Auth follows the authRouter pattern: `Authorization: Bearer <jwt>` →
 * `validateToken` → userId. Bodies are zod-validated (invariant #3). See
 * docs/architecture/web-push.md.
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import { validateToken } from '../auth/AuthService.js';
import { vapidPublicKey, pushEnabled } from '../push/webPush.js';
import { putSubscription, deleteSubscriptionByEndpoint } from '../push/pushSubscriptions.js';

export const pushRouter: RouterType = Router();

function bearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

const SubscribeBodySchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(256),
      auth: z.string().min(1).max(256),
    }),
  })
  .strict();

const UnsubscribeBodySchema = z.object({ endpoint: z.string().url().max(2048) }).strict();

pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ publicKey: vapidPublicKey, enabled: pushEnabled });
});

pushRouter.post('/subscribe', async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const userId = await validateToken(token);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = SubscribeBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid subscription' }); return; }

  putSubscription(userId, parsed.data.endpoint, parsed.data.keys.p256dh, parsed.data.keys.auth);
  res.json({ ok: true });
});

pushRouter.post('/unsubscribe', async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const userId = await validateToken(token);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = UnsubscribeBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid endpoint' }); return; }

  deleteSubscriptionByEndpoint(parsed.data.endpoint);
  res.json({ ok: true });
});
