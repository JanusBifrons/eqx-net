import { SignJWT, jwtVerify } from 'jose';

/** The dev-only fallback. A production server that boots with this (or no)
 *  secret would mint forgeable sessions, so we fail closed instead. */
const PLACEHOLDER_SECRET = 'dev-secret-change-in-production';

/**
 * Resolve the JWT signing secret, failing closed in production (plan
 * squishy-canyon, finding S9). In non-production a missing secret falls back to
 * the placeholder so the dev loop works with zero config. In production a
 * missing OR literal-placeholder `JWT_SECRET` throws — a server that would mint
 * forgeable sessions must NOT start. Exported for the boot-time env tests.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['JWT_SECRET'];
  if (env['NODE_ENV'] === 'production') {
    if (!configured || configured === PLACEHOLDER_SECRET) {
      throw new Error(
        'JWT_SECRET must be set to a non-placeholder value in production — ' +
          'refusing to start with a forgeable session secret (S9).',
      );
    }
    return configured;
  }
  return configured ?? PLACEHOLDER_SECRET;
}

const secret = new TextEncoder().encode(resolveJwtSecret());

const TTL_DAYS = Number(process.env['SESSION_TTL_DAYS'] ?? 30);

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TTL_DAYS}d`)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
