/**
 * Shared helpers for the Living World showcase recordings (NOT gates).
 * Reads the live client mirror via `window.__eqxClient` (dev builds).
 */
import type { Page } from '@playwright/test';

export interface Pose { x: number; y: number; angle: number }

export type ClientShape = {
  mirror?: {
    localPlayerId?: string | null;
    ships?: Map<string, Pose>;
    swarm?: Map<number, { kind: number; shipKind?: string; x: number; y: number }>;
  };
  getRoom?: () => { send: (type: string, msg: unknown) => void } | null;
};

export async function localPose(page: Page): Promise<Pose | null> {
  return page.evaluate(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    const id = c?.mirror?.localPlayerId;
    const s = id ? c?.mirror?.ships?.get(id) : undefined;
    return s ? { x: s.x, y: s.y, angle: s.angle } : null;
  });
}

export async function podPositions(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    const out: Array<{ x: number; y: number }> = [];
    for (const e of c?.mirror?.swarm?.values() ?? []) {
      if (e.kind === 3 && e.shipKind === 'cargo-pod') out.push({ x: e.x, y: e.y });
    }
    return out;
  });
}

/** Count live kind-1 combatants whose ship kind starts with `prefix`. */
export async function countCombatants(page: Page, prefix: string): Promise<number> {
  return page.evaluate((p) => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    let n = 0;
    for (const e of c?.mirror?.swarm?.values() ?? []) {
      if (e.kind === 1 && (e.shipKind ?? '').startsWith(p)) n++;
    }
    return n;
  }, prefix);
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Steer the local ship to (tx, ty) with the real keyboard (nose = (-sin a, cos a);
 *  turnLeft increases the angle). Brakes on approach. Returns true on arrival. */
export async function flyTo(page: Page, tx: number, ty: number, arrive: number, maxMs: number): Promise<boolean> {
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { await page.keyboard.down(key); held.add(key); }
    if (!on && held.has(key)) { await page.keyboard.up(key); held.delete(key); }
  };
  const end = Date.now() + maxMs;
  let arrived = false;
  let prev: { x: number; y: number; t: number } | null = null;
  while (Date.now() < end) {
    const p = await localPose(page);
    if (p) {
      const now = Date.now();
      const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(0.001, (now - prev.t) / 1000) : 0;
      prev = { x: p.x, y: p.y, t: now };
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arrive && speed < 150) { arrived = true; break; }
      const diff = wrapPi(Math.atan2(-dx, dy) - p.angle);
      await set('ArrowLeft', diff > 0.08);
      await set('ArrowRight', diff < -0.08);
      const cruise = Math.max(120, dist * 0.8);
      const facing = Math.abs(diff) < 0.6;
      await set('ArrowUp', facing && speed < cruise);
      await set('ArrowDown', facing && speed > cruise * 1.3 && dist < 600);
    }
    await page.waitForTimeout(50);
  }
  for (const k of [...held]) await set(k, false);
  return arrived;
}
