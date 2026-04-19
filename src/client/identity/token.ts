const STORAGE_KEY = 'eqxPlayerId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadStoredPlayerId(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function persistPlayerId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage quota exceeded — carry on
  }
}
