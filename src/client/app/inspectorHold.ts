/**
 * The world-anchored inspector (EntityStatsPanel) follows its target every
 * frame, so its buttons are a moving target: in the 1v3 clip a LOCK tap missed,
 * and on CI a click on CANCEL never landed (Playwright waits for the element to
 * stop moving; the click then hit the canvas and deselected the target). While
 * a pointer is over the panel or pressing it, the panel holds still.
 *
 * Listeners are attached once per panel element (WeakSets, so a remounted panel
 * is wired afresh and nothing leaks). Touch: pointerenter/pointerleave fire
 * around a touch, so the hold lasts exactly as long as the finger is down.
 */
const wired = new WeakSet<HTMLElement>();
const held = new WeakSet<HTMLElement>();

function wire(panel: HTMLElement): void {
  wired.add(panel);
  const hold = (): void => { held.add(panel); };
  const release = (): void => { held.delete(panel); };
  panel.addEventListener('pointerenter', hold);
  panel.addEventListener('pointerdown', hold);
  panel.addEventListener('pointerleave', release);
  panel.addEventListener('pointercancel', release);
}

/** True while a pointer is over (or pressing) the panel: don't move it. */
export function isInspectorHeld(panel: HTMLElement): boolean {
  if (!wired.has(panel)) wire(panel);
  return held.has(panel);
}
