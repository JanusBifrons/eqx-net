import type { AuthUser } from '../../shared-types/auth.js';

interface AuthResponse {
  token: string;
  user: AuthUser;
}

async function request<T>(path: string, options: RequestInit): Promise<T> {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function apiRegister(
  email: string,
  password: string,
  confirmPassword: string,
  displayName?: string,
): Promise<AuthResponse> {
  return request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, confirmPassword, displayName }),
  });
}

export async function apiLogin(email: string, password: string): Promise<AuthResponse> {
  return request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export async function apiGetMe(token: string): Promise<{ user: AuthUser }> {
  return request('/auth/me', { headers: authHeaders(token) });
}

/** Swap a single-use OAuth code (from the /?authCode= redirect) for the
 *  session token + user (S3). Keeps the JWT out of the URL. */
export async function exchangeAuthCode(code: string): Promise<AuthResponse> {
  return request('/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export async function apiUpdateProfile(
  token: string,
  displayName: string,
): Promise<{ user: AuthUser }> {
  return request('/auth/profile', {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ displayName }),
  });
}
