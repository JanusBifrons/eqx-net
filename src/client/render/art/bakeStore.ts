/**
 * Machined art — baked art kept between sessions (IndexedDB), so only a device's
 * first load pays for baking.
 *
 * Entries are keyed by `FORGE_VERSION` + the bake key + the light rig, so any
 * change to the forge or the sun simply misses and re-bakes. Every call is
 * best-effort: a private window, a full disk or a blocked store just means
 * "not cached", never an error.
 */
import type { Baked } from './bake.js';
import type { LightRig } from './shade.js';

/** Bump whenever forge output changes, or old art would be served. */
export const FORGE_VERSION = 'r2.1';

const DB = 'eqx-art-lab';
const STORE = 'bakes';

let dbP: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = (): void => { req.result.createObjectStore(STORE); };
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => resolve(null);
      req.onblocked = (): void => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

export function storeKey(key: string, rig: LightRig): string {
  return `${FORGE_VERSION}|${key}|${rig.sunAz.toFixed(4)}|${rig.sunElev.toFixed(4)}|${rig.exposure}`;
}

export async function loadBakes(keys: string[]): Promise<Map<string, Baked>> {
  const out = new Map<string, Baked>();
  const db = await open();
  if (!db || keys.length === 0) return out;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      for (const k of keys) {
        const r = st.get(k);
        r.onsuccess = (): void => { if (r.result) out.set(k, r.result as Baked); };
      }
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => resolve();
      tx.onabort = (): void => resolve();
    } catch {
      resolve();
    }
  });
  return out;
}

export async function saveBakes(entries: Array<[string, Baked]>): Promise<void> {
  const db = await open();
  if (!db || entries.length === 0) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const [k, b] of entries) st.put(b, k);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => resolve();
      tx.onabort = (): void => resolve();
    } catch {
      resolve();
    }
  });
}
