/**
 * A siege shell's `shell_blast` waits for the drawn shell's burst (off-pilot
 * event timing, slice 4/6). It arrives with the shell's hit, a display delay
 * ahead of the drawn shell; `NavalHitHold.maybeHoldBlast` holds it, its
 * `shell_end` (same point) gives the hit tick, and `release` hands it to the
 * sink the frame the display tick reaches it, piloting (~150 ms) and off
 * pilot (~2 s). Mock clocks only: display tick and game ms are passed in.
 */
import { describe, expect, it } from 'vitest';
import type { Room } from 'colyseus.js';
import type { RenderMirror, ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import type { DamageEvent } from '@shared-types/messages';
import { MAX_HOLD_MS, NavalHitHold, type HeldDamage, type HeldDamageSink } from './navalHitHold.js';
import { registerShellHandlers, type ShellHandlerCtx } from './handlers/shellHandlers.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';

const TICK_MS = 1000 / 60;
const GAME0 = 50_000;
/** The tick the shell hits at (its `shell_end`). */
const END_TICK = 1000;

class Sink implements HeldDamageSink {
  readonly blasts: [number, number, number][] = [];
  readonly hits: string[] = [];
  applyHeldDamage(h: HeldDamage): void {
    if (h.blastRadius > 0) this.blasts.push([h.evt.hitX!, h.evt.hitY!, h.blastRadius]);
    else this.hits.push(h.evt.targetId);
  }
}

/** A live, unended siege shell from (0, 0) along +x through (100, 0). */
function shells(): Map<string, ShellSalvoRenderInfo> {
  return new Map([['s1', {
    s: 1, t: 0, n: 60, x0: 0, y0: 0, wr: 2, vx: 600, vy: 0, o: 'p1', w: 'gun', endTick: -1, ex: 0, ey: 0,
  }]]);
}

function dmg(targetId: string, newHealth = 50): DamageEvent {
  return {
    type: 'damage', targetId, damage: 10, newHealth, shooterId: 'p1',
    newShield: 0, shieldMax: 0, hullMax: 100, hitLayer: 'hull', hitX: 100, hitY: 0,
  };
}

/** Blast held at arrival (GAME0), matched by its shell_end; the display is
 *  `delayMs` behind, so it reaches END_TICK `delayMs` game ms later. */
function heldAndMatched(offPilot: boolean): { hold: NavalHitHold; sink: Sink } {
  const hold = new NavalHitHold();
  const sink = new Sink();
  expect(hold.maybeHoldBlast(100, 0, 300, shells(), GAME0)).toBe(true);
  hold.onShellEnd(END_TICK, 100, 0, GAME0, offPilot);
  return { hold, sink };
}

describe('shell_blast waits for the drawn shell', () => {
  it.each([
    ['piloting', false, 150],
    ['off pilot', true, 2000],
  ])('%s: appears only when the display tick reaches the shell end', (_, offPilot, delayMs) => {
    const { hold, sink } = heldAndMatched(offPilot);
    const displayAt = (gameMs: number): number => END_TICK + (gameMs - GAME0 - delayMs) / TICK_MS;
    // Every frame up to just before the drawn shell gets there: still held.
    for (let t = GAME0; t < GAME0 + delayMs - TICK_MS; t += TICK_MS) {
      hold.release(displayAt(t), t, sink);
      expect(sink.blasts).toEqual([]);
    }
    hold.release(displayAt(GAME0 + delayMs), GAME0 + delayMs, sink);
    expect(sink.blasts).toEqual([[100, 0, 300]]);
    expect(hold.size).toBe(0);
  });

  it('off pilot, the pilot deadline does not release it early', () => {
    const { hold, sink } = heldAndMatched(true);
    hold.release(END_TICK - 1, GAME0 + MAX_HOLD_MS + 1, sink);
    expect(sink.blasts).toEqual([]);
  });

  it('a blast off any live shell path is not held (drawn on arrival)', () => {
    const hold = new NavalHitHold();
    expect(hold.maybeHoldBlast(100, 500, 300, shells(), GAME0)).toBe(false);
    expect(hold.maybeHoldBlast(100, 0, 300, new Map(), GAME0)).toBe(false);
    expect(hold.size).toBe(0);
  });

  it('a lost shell_end still shows it after the unmatched safety', () => {
    const hold = new NavalHitHold();
    const sink = new Sink();
    hold.maybeHoldBlast(100, 0, 300, shells(), GAME0);
    hold.release(0, GAME0 + 1000, sink);
    expect(sink.blasts).toEqual([[100, 0, 300]]);
  });

  it('never stands in for a kill, a beam hit or a target', () => {
    const { hold, sink } = heldAndMatched(false);
    expect(hold.holdsKill('')).toBe(false);
    expect(hold.releaseHitAt('', 100, 0, sink)).toBe(false);
    hold.flushTarget('swarm-7', sink);
    expect(sink.blasts).toEqual([]);
    expect(hold.size).toBe(1);
  });

  it('flush (welcome / sector change) drops held blasts and still releases hits', () => {
    const { hold, sink } = heldAndMatched(true);
    hold.maybeHold(dmg('swarm-7'), false, shells(), GAME0);
    hold.flush(sink);
    expect(sink.blasts).toEqual([]);
    expect(sink.hits).toEqual(['swarm-7']);
    expect(hold.size).toBe(0);
  });
});

describe('shell_blast handler', () => {
  function rig(holdBlast: ShellHandlerCtx['holdBlast']): { fire: (msg: unknown) => void; mirror: RenderMirror } {
    let onBlast: (msg: unknown) => void = () => {};
    const room = {
      onMessage: (type: string, cb: (msg: unknown) => void) => { if (type === 'shell_blast') onBlast = cb; },
    } as unknown as Room;
    const mirror = {} as RenderMirror;
    registerShellHandlers(room, {
      mirror, shellStore: {} as ShellSalvoStore, shellEvents: () => true, applyShellEnd: () => {}, holdBlast,
    });
    return { fire: onBlast, mirror };
  }
  const msg = { type: 'shell_blast', x: 100, y: 0, radius: 300 };

  it('draws it now when not held', () => {
    const { fire, mirror } = rig(() => false);
    fire(msg);
    expect(mirror.pendingMissileExplosions).toEqual([{ x: 100, y: 0, splashRadius: 300, missileId: -1 }]);
  });

  it('draws nothing on arrival when held', () => {
    const seen: number[][] = [];
    const { fire, mirror } = rig((x, y, r) => { seen.push([x, y, r]); return true; });
    fire(msg);
    expect(seen).toEqual([[100, 0, 300]]);
    expect(mirror.pendingMissileExplosions ?? []).toEqual([]);
  });
});
