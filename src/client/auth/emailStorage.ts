// Persisted copy of the logged-in account email. Peer of `tokenStorage.ts`.
//
// Why this exists: the account-gated default-on autocapture
// (`debug/ClientLogger.ts` → `isAutoCaptureEnabled()`) has to decide at
// MODULE-LOAD time (App.tsx top-level `installStreamingDiag()`), which is
// BEFORE auth resolves. The Zustand auth store only holds the user object
// in memory, so the gate cannot read it at boot. Persisting the email
// (written in `authStore.setAuth`, cleared in `clearAuth`) lets the gate
// read a durable identity synchronously at boot — exactly the same pattern
// the token uses. The email is the user's own, already inside the JWT, and
// stored only on their own device.
const KEY = 'eqxAuthEmail';

/** Persisted lower-cased account email, or null. Try/catch wrapped so a
 *  non-browser / storage-disabled context resolves to null rather than
 *  throwing (the autocapture gate runs in node unit tests too). */
export function loadEmail(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveEmail(email: string): void {
  try {
    localStorage.setItem(KEY, email.trim().toLowerCase());
  } catch {
    // storage quota / disabled — carry on; autocapture just stays off.
  }
}

export function clearEmail(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
