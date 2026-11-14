/**
 * Take 12 film review: AI pilots hold the boost key often, yet their ships
 * showed only a faint exhaust, never the blue boost flame. Their boost was
 * guessed from speed (on only above ~70 % of top speed, full at 95 %), so a
 * boosting AI ship turning or closing in a melee rarely lit up. Now its boost
 * follows its pilot's real key from the snapshot, exactly like a pilot's.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { FxEngines, type Nozzle } from '../art/fx/FxEngines.js';
import { droneBoostInput } from './droneEngineInput.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

const TWIN: Nozzle[] = [{ x: -4, y: 10, r: 2 }, { x: 4, y: 10, r: 2 }];
const TOP = 800;
const DT = 1 / 60;

/** Fly an AI ship at 60 % of top speed for 1 s with the given swarm entry. */
function boostAfterFlight(entry: { boosting?: boolean }): number {
  const fx = new FxEngines(fakeArt());
  let x = 0;
  for (let f = 0; f < 60; f++) {
    fx.beginFrame();
    fx.draw('swarm-7', TWIN, x, 0, Math.PI / 2, -1, droneBoostInput(entry), TOP, DT, f * 16.7);
    fx.endFrame();
    x += TOP * 0.6 * DT;
  }
  return fx.debugView('swarm-7')!.boost;
}

describe('an AI ship\'s boost flame follows its pilot\'s boost key', () => {
  it('maps the snapshot bit to the engine input', () => {
    expect(droneBoostInput({ boosting: true })).toBe(1);
    expect(droneBoostInput({ boosting: false })).toBe(0);
    expect(droneBoostInput({})).toBe(0);
    expect(droneBoostInput(undefined)).toBe(0);
  });

  it('boosting below the old speed guess draws the full boost flame', () => {
    expect(boostAfterFlight({ boosting: true })).toBeGreaterThan(0.95);
  });

  it('not boosting draws no boost, however fast', () => {
    expect(boostAfterFlight({ boosting: false })).toBeLessThan(0.01);
  });
});
