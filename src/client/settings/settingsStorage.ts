const KEY = 'eqxSettings';

export interface PersistedSettings {
  showDevOverlay: boolean;
  showLogPanel: boolean;
  showServerGhost: boolean;
}

export function loadSettings(): Partial<PersistedSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Partial<PersistedSettings> = {};
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['showDevOverlay']  === 'boolean') out.showDevOverlay  = obj['showDevOverlay'];
    if (typeof obj['showLogPanel']    === 'boolean') out.showLogPanel    = obj['showLogPanel'];
    if (typeof obj['showServerGhost'] === 'boolean') out.showServerGhost = obj['showServerGhost'];
    return out;
  } catch {
    return {};
  }
}

export function saveSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // localStorage can throw in private mode / quota-exceeded — ignore, settings
    // simply won't persist this session.
  }
}
