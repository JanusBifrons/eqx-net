import { expect, type Page } from '@playwright/test';

/**
 * Fire control (lock-to-fire, universal since 2026-11-09): a weapon group fires
 * ONLY at a target it has a COMPLETED lock on. Specs that are ABOUT locking use
 * `lockOn` (select → LOCK in the info box → chip `data-locked="1"`); specs that
 * merely need to shoot something should join with `instantLock` instead (the
 * AUTO group then locks whatever is in front within ~0.1 s and fires on its own).
 *
 * Pair `lockOn` with `instantLock` when the lock itself is not under test —
 * otherwise a non-hostile target (another player, a neutral drone) runs the
 * full failsafe-ring lock time.
 */

/** A lock target: a swarm entity (drone / structure) by entityId, another
 *  player's ship by playerId, or the first NPC drone in this client's mirror. */
export type LockTarget =
  | { kind: 'drone' | 'structure'; entityId: number }
  | { kind: 'ship'; playerId: string }
  | 'first-drone';

export const fcChips = (page: Page) => page.locator('[data-testid^="fc-chip-"]');

/** Wait for the fire-control weapon strip (the only HUD) to mount. */
export async function waitForFireControlHud(page: Page, timeoutMs = 30_000): Promise<void> {
  await fcChips(page).first().waitFor({ timeout: timeoutMs });
}

/** The active weapon group's id (the group LOCK / Space act on). */
export async function activeGroupId(page: Page): Promise<string> {
  await waitForFireControlHud(page);
  const id = await page.evaluate(() => {
    const w = window as unknown as { __eqxStore?: { getState(): { activeGroupId: string | null } } };
    return w.__eqxStore?.getState().activeGroupId ?? null;
  });
  if (id) return id;
  const tid = (await page.locator('[data-testid^="fc-chip-"][data-active="1"]').first().getAttribute('data-testid')) ?? '';
  return tid.slice('fc-chip-'.length);
}

/** Put a weapon group in MAN (so it never self-picks) and drop its locks. */
export async function toManual(page: Page, groupId?: string): Promise<string> {
  const id = groupId ?? (await activeGroupId(page));
  const mode = page.locator(`[data-testid="fc-mode-${id}"]`);
  if ((await mode.getAttribute('data-state')) !== 'manual') await mode.click();
  await expect(mode).toHaveAttribute('data-state', 'manual', { timeout: 5_000 });
  const clear = page.locator(`[data-testid="fc-clear-${id}"]`);
  if (await clear.count()) await clear.click();
  await expect(page.locator(`[data-testid="fc-chip-${id}"]`)).toHaveAttribute('data-locked', '0', { timeout: 5_000 });
  return id;
}

/** Make `groupId` (a slot id, e.g. 'missiles') the active weapon group — the
 *  group LOCK and Space act on. Goes through the store (a chip tap would also
 *  fire a MAN group). */
export async function setActiveGroup(page: Page, groupId: string): Promise<void> {
  await page.locator(`[data-testid="fc-chip-${groupId}"]`).waitFor({ timeout: 30_000 });
  await page.evaluate((id) => {
    const w = window as unknown as { __eqxStore?: { getState(): { setActiveGroupId(id: string | null): void } } };
    w.__eqxStore?.getState().setActiveGroupId(id);
  }, groupId);
  await expect(page.locator(`[data-testid="fc-chip-${groupId}"]`)).toHaveAttribute('data-active', '1', { timeout: 5_000 });
}

/** Put a weapon group in AUTO (fires on its own at its completed locks). */
export async function toAuto(page: Page, groupId: string): Promise<void> {
  const mode = page.locator(`[data-testid="fc-mode-${groupId}"]`);
  if ((await mode.getAttribute('data-state')) !== 'auto') await mode.click();
  await expect(mode).toHaveAttribute('data-state', 'auto', { timeout: 5_000 });
}

/**
 * Lock `target` with the active weapon group through the real UI: select it
 * (Zustand selection — the same state a tap sets, renderer-independent so it
 * works with the worker renderer too), press LOCK in its info box
 * (`[data-testid="fc-target"]`) and wait for the group's chip to read
 * `data-locked="1"`. Returns the group id. A target the AUTO group already
 * locked (button reads UNLOCK) counts as done.
 */
export async function lockOn(page: Page, target: LockTarget, opts: { timeoutMs?: number } = {}): Promise<string> {
  const groupId = await activeGroupId(page);
  const sel = await page.waitForFunction(
    (t) => {
      const w = window as unknown as {
        __eqxStore?: { getState(): { setSelectedEntity(id: string | null, kind: string | null): void } };
        __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number }>; ships?: Map<string, unknown> } };
      };
      const store = w.__eqxStore?.getState();
      const mirror = w.__eqxClient?.mirror;
      if (!store || !mirror) return null;
      let id: string | null = null;
      let kind: string | null = null;
      if (t === 'first-drone') {
        for (const [eid, e] of mirror.swarm ?? []) if (e.kind === 1) { id = `swarm-${eid}`; kind = 'drone'; break; }
      } else if (t.kind === 'ship') {
        if (mirror.ships?.has(t.playerId)) { id = t.playerId; kind = 'ship'; }
      } else if (mirror.swarm?.has(t.entityId)) {
        id = `swarm-${t.entityId}`;
        kind = t.kind;
      }
      if (id === null) return null;
      store.setSelectedEntity(id, kind);
      return id;
    },
    target,
    { timeout: 15_000 },
  );
  expect(await sel.jsonValue()).not.toBeNull();
  const btn = page.locator('[data-testid="fc-target"]');
  await expect(btn).toHaveAttribute('data-state', /^(lock|unlock|cancel)$/, { timeout: 5_000 });
  // dispatchEvent, not click(): the info box is world-anchored (moved every frame
  // to the target's screen pose; parked off-screen by the worker renderer), so
  // Playwright's visible/stable actionability checks never settle.
  if ((await btn.getAttribute('data-state')) === 'lock') await btn.dispatchEvent('click');
  await expect(page.locator(`[data-testid="fc-chip-${groupId}"]`)).toHaveAttribute('data-locked', '1', {
    // Real lock time when the target is not hostile and instantLock is off: the
    // failsafe ring + lock is ~10 s for an interceptor on a fighter (probe 2026-11-09).
    timeout: opts.timeoutMs ?? 20_000,
  });
  // The LOCK <button> keeps focus after the click: a later Space press would
  // "click" it again (UNLOCK) instead of reaching the game's key handler.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  return groupId;
}
