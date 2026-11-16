import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { raiseBeamsOverHulls, BEAMS_OVER_HULL_Z, VAPORISE_OVER_BEAMS_Z } from './beamsOverHulls.js';

describe('raiseBeamsOverHulls', () => {
  it('beam layers sort above hulls that spawn after them, other layers keep their order', () => {
    const ships = new Container();
    const fxBelow = new Container();
    const beam = new Container();
    const fxAfter = new Container();
    ships.addChild(fxBelow, beam, fxAfter);
    raiseBeamsOverHulls(ships, [beam]);
    const hull = new Container(); // a ship sprite appended at spawn
    ships.addChild(hull);
    ships.sortChildren();
    expect(ships.getChildIndex(beam)).toBeGreaterThan(ships.getChildIndex(hull));
    expect(ships.getChildIndex(fxBelow)).toBeLessThan(ships.getChildIndex(fxAfter));
    expect(ships.getChildIndex(fxAfter)).toBeLessThan(ships.getChildIndex(hull));
  });

  it('the vaporise flash stays over the beams', () => {
    expect(VAPORISE_OVER_BEAMS_Z).toBeGreaterThan(BEAMS_OVER_HULL_Z);
  });
});
