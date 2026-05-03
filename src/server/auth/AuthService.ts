import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/Database.js';
import { signToken, verifyToken } from './jwt.js';
import type { GoogleProfile } from './GoogleOAuth.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
}

const BCRYPT_ROUNDS = 12;

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ token: string; user: AuthUser }> {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw new Error('EMAIL_TAKEN');

  const id = randomUUID();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now = Date.now();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, email.toLowerCase(), hash, displayName ?? null, now, now);

  db.prepare(
    'INSERT INTO auth_providers (id, user_id, provider, provider_id) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), id, 'local', email.toLowerCase());

  const token = await signToken(id);
  return { token, user: { id, email: email.toLowerCase(), displayName: displayName ?? null } };
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  const row = db
    .prepare('SELECT id, email, password_hash, display_name FROM users WHERE email = ?')
    .get(email.toLowerCase()) as UserRow | undefined;

  if (!row?.password_hash) throw new Error('INVALID_CREDENTIALS');

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw new Error('INVALID_CREDENTIALS');

  const token = await signToken(row.id);
  return { token, user: { id: row.id, email: row.email, displayName: row.display_name } };
}

export async function validateToken(token: string): Promise<string | null> {
  return verifyToken(token);
}

export function getUser(userId: string): AuthUser | null {
  const row = db
    .prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    .get(userId) as Pick<UserRow, 'id' | 'email' | 'display_name'> | undefined;
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export function updateDisplayName(userId: string, displayName: string): AuthUser | null {
  db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(
    displayName,
    Date.now(),
    userId,
  );
  return getUser(userId);
}

export async function findOrCreateGoogleUser(profile: GoogleProfile): Promise<{ token: string; user: AuthUser }> {
  const existing = db
    .prepare(
      'SELECT u.id, u.email, u.display_name FROM users u JOIN auth_providers ap ON ap.user_id = u.id WHERE ap.provider = ? AND ap.provider_id = ?',
    )
    .get('google', profile.id) as Pick<UserRow, 'id' | 'email' | 'display_name'> | undefined;

  if (existing) {
    const token = await signToken(existing.id);
    return {
      token,
      user: { id: existing.id, email: existing.email, displayName: existing.display_name },
    };
  }

  // Link to existing local account if emails match, otherwise create new user.
  let userId: string;
  const byEmail = db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(profile.email.toLowerCase()) as { id: string } | undefined;

  const now = Date.now();
  if (byEmail) {
    userId = byEmail.id;
  } else {
    userId = randomUUID();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(userId, profile.email.toLowerCase(), null, profile.name ?? null, now, now);
  }

  db.prepare(
    'INSERT OR IGNORE INTO auth_providers (id, user_id, provider, provider_id) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), userId, 'google', profile.id);

  const user = getUser(userId)!;
  const token = await signToken(userId);
  return { token, user };
}
