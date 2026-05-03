const KEY = 'eqxAuthToken';

export function loadToken(): string | null {
  return localStorage.getItem(KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
