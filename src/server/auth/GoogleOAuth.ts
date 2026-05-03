const CLIENT_ID = process.env['GOOGLE_API_CLIENT_ID'] ?? '';
const CLIENT_SECRET = process.env['GOOGLE_API_CLIENT_SECRET'] ?? '';
const REDIRECT_URI = process.env['GOOGLE_REDIRECT_URI'] ?? 'http://localhost:5173/auth/google/callback';

export function authorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
}

export interface GoogleProfile {
  id: string;
  email: string;
  name?: string;
  verified_email?: boolean;
}

export async function exchangeCode(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${body}`);
  }

  const tokens = (await tokenRes.json()) as TokenResponse;

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    const body = await userRes.text().catch(() => '');
    throw new Error(`Google userinfo failed: ${userRes.status} ${body}`);
  }

  return (await userRes.json()) as GoogleProfile;
}
