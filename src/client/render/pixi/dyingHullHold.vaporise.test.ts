/**
 * A vaporised death (fracture v11: a heavy-beam / railgun kill burned the
 * whole hull away, `destroy.vaporised`) leaves no wreck piece, so the dying
 * hull must NOT be held waiting for pieces that never come.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { DyingHullHold, noteDyingHulls } from './dyingHullHold.js';

const kindOf = (id: string): string | undefined => (id.startsWith('f') ? 'fighter' : id.startsWith('b') ? 'battleship' : undefined);

describe('dying-hull hold: vaporised deaths are not held', () => {
  it('a vaporised sub-cap is not held; a normal sub-cap death still is', () => {
    const hold = new DyingHullHold();
    const exploding = new Set(['f1', 'f2']);
    const vaporised = new Set(['f1']);
    noteDyingHulls(exploding, false, kindOf, hold, 1000, true, vaporised);
    expect(hold.tryHold('f1', new Container(), 1000), 'vaporised: swept at once').toBe(false);
    expect(hold.tryHold('f2', new Container(), 1000), 'normal death: held for its wreck').toBe(true);
    expect(hold.heldCountNow()).toBe(1);
  });

  it('a vaporised capital is not held either', () => {
    const hold = new DyingHullHold();
    noteDyingHulls(new Set(['b1']), true, kindOf, hold, 1000, true, new Set(['b1']));
    expect(hold.tryHold('b1', new Container(), 1000)).toBe(false);
  });

  it('no vaporised set (or an empty one) behaves as before', () => {
    const hold = new DyingHullHold();
    noteDyingHulls(new Set(['f1']), false, kindOf, hold, 1000, true, new Set());
    expect(hold.tryHold('f1', new Container(), 1000)).toBe(true);
  });
});
