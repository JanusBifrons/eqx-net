import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { randomUUID } from 'node:crypto';
import {
  register,
  login,
  validateToken,
  getUser,
  updateDisplayName,
  findOrCreateGoogleUser,
} from '../auth/AuthService.js';
import { authorizationUrl, exchangeCode } from '../auth/GoogleOAuth.js';
import { recordLoginEvent } from '../stats/StatsService.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
} from '../../shared-types/auth.js';

export const authRouter: RouterType = Router();

function bearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function clientIp(req: Request): string | null {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? null;
}

authRouter.post('/register', async (req: Request, res: Response) => {
  const parsed = RegisterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const { token, user } = await register(
      parsed.data.email,
      parsed.data.password,
      parsed.data.displayName,
    );
    recordLoginEvent(parsed.data.email, user.id, true, 'local', clientIp(req));
    res.json({ token, user });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'UNKNOWN';
    if (msg === 'EMAIL_TAKEN') {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  try {
    const { token, user } = await login(parsed.data.email, parsed.data.password);
    recordLoginEvent(parsed.data.email, user.id, true, 'local', clientIp(req));
    res.json({ token, user });
  } catch {
    recordLoginEvent(parsed.data.email, null, false, 'local', clientIp(req));
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

authRouter.get('/me', async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const userId = await validateToken(token);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const user = getUser(userId);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ user });
});

authRouter.patch('/profile', async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const userId = await validateToken(token);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = UpdateProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid input' });
    return;
  }
  const user = updateDisplayName(userId, parsed.data.displayName);
  res.json({ user });
});

// In-memory state store for CSRF protection on the OAuth round-trip.
const oauthStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

authRouter.get('/google', (_req: Request, res: Response) => {
  const state = randomUUID();
  oauthStates.set(state, Date.now());
  res.redirect(authorizationUrl(state));
});

authRouter.get('/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) { res.status(400).send('Missing code or state'); return; }

  const issued = oauthStates.get(state);
  if (!issued || Date.now() - issued > STATE_TTL_MS) {
    res.status(400).send('Invalid or expired state');
    return;
  }
  oauthStates.delete(state);

  try {
    const profile = await exchangeCode(code);
    const { token, user } = await findOrCreateGoogleUser(profile);
    recordLoginEvent(profile.email, user.id, true, 'google', clientIp(req));
    res.redirect(`/?token=${encodeURIComponent(token)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[auth/google/callback]', msg);
    res.status(500).send(`OAuth error: ${msg}`);
  }
});
