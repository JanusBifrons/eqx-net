import { Router, type Request, type Response, type Router as RouterType } from 'express';
import {
  register,
  login,
  validateToken,
  getUser,
  updateDisplayName,
  findOrCreateGoogleUser,
  findOrCreateTestUser,
} from '../auth/AuthService.js';
import { authorizationUrl, exchangeCode } from '../auth/GoogleOAuth.js';
import { recordLoginEvent } from '../stats/StatsService.js';
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
} from '../../shared-types/auth.js';
import { createRateLimiter, clientIp } from '../net/HttpRateLimit.js';
import { resolveJwtSecret } from '../auth/jwt.js';
import { createOAuthState, verifyOAuthState } from '../auth/oauthState.js';

export const authRouter: RouterType = Router();

// Per-IP fixed-window rate limits (S2) so the bcrypt login/register endpoints
// can't be used as a CPU brute-force surface. One shared limiter per category
// gives a combined budget across its routes per IP; cheap routes (/healthz,
// /diag) are intentionally not limited.
const AUTH_WRITE_WINDOW_MS = 60_000;
const AUTH_WRITE_MAX = 10; // login + register, combined, per IP per minute
const OAUTH_WINDOW_MS = 60_000;
const OAUTH_MAX = 30; // /auth/google* per IP per minute
const authWriteLimiter = createRateLimiter({ windowMs: AUTH_WRITE_WINDOW_MS, max: AUTH_WRITE_MAX });
const oauthLimiter = createRateLimiter({ windowMs: OAUTH_WINDOW_MS, max: OAUTH_MAX });

function bearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

authRouter.post('/register', authWriteLimiter, async (req: Request, res: Response) => {
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

authRouter.post('/login', authWriteLimiter, async (req: Request, res: Response) => {
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

// Stateless signed CSRF state for the OAuth round-trip (S4). Replaces the
// former in-memory Map (raced, lost on restart, broke multi-instance). The
// HMAC key is the same fail-closed secret used for session JWTs.
const oauthStateSecret = resolveJwtSecret();

// Dev-only: mint a real JWT for a deterministic test user. Used by the
// Playwright globalSetup to bypass the login UI without faking auth state.
// Hard-gated on NODE_ENV so this can never be reached in production.
if (process.env['NODE_ENV'] !== 'production') {
  authRouter.post('/dev/test-token', async (req: Request, res: Response) => {
    try {
      // Optional ?email= override so multi-user E2Es (e.g. Phase 7
      // persistence-kill) can mint distinct tokens. Default keeps the
      // single-user globalSetup contract intact.
      const emailRaw = (req.query['email'] as string | undefined) ?? 'e2e@test.local';
      // Defensive: only allow simple email-shaped strings to avoid weird
      // injection paths into the users table key.
      const email = /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(emailRaw.toLowerCase())
        ? emailRaw.toLowerCase()
        : 'e2e@test.local';
      const { token, user } = await findOrCreateTestUser(email);
      res.json({ token, user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('[auth/dev/test-token]', msg);
      res.status(500).json({ error: 'dev test-token mint failed' });
    }
  });
}

authRouter.get('/google', oauthLimiter, (_req: Request, res: Response) => {
  const state = createOAuthState(oauthStateSecret);
  res.redirect(authorizationUrl(state));
});

authRouter.get('/google/callback', oauthLimiter, async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) { res.status(400).send('Missing code or state'); return; }

  if (!verifyOAuthState(state, oauthStateSecret)) {
    res.status(400).send('Invalid or expired state');
    return;
  }

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
