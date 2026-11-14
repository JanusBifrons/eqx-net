/**
 * Ship livery for player ships: under `?livery=` a player's ship requests
 * its owner's team colour + sigil (the mirror key is the player's faction
 * id); with the flag off the request is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { updateShipSprites, type ShipSpriteCtx } from './shipSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { teamColorOf, teamSigilOf } from '../../../shared-types/factions.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';

function run(livery: 'b' | undefined): Array<unknown[]> {
  const calls: Array<unknown[]> = [];
  const svc = {
    lightRig: {},
    ship: (...args: unknown[]) => {
      calls.push(args);
      return { key: 'k', job: { type: 'ship', id: args[0], paint: args[1] }, rig: {}, state: 'pending', ship: null, struct: null } as unknown as ArtHandle;
    },
  } as unknown as ArtService;
  const ctx: ShipSpriteCtx = {
    shipContainer: new Container(),
    sprites: new Map(),
    art: { art: svc, handles: new Map(), sunAz: 0, ...(livery ? { livery } : {}) },
    mountVisuals: new MountVisualManager(),
    remoteHitTargets: new Set(),
    localHitTargets: new Set(),
    seenScratch: new Set(),
  };
  const ship = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' };
  updateShipSprites({ ships: new Map([['player-abc', ship]]) } as unknown as RenderMirror, ctx);
  return calls;
}

describe('updateShipSprites — livery', () => {
  it('a player ship wears its own faction colour under ?livery=', () => {
    const calls = run('b');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBeUndefined();
    expect(calls[0]![4]).toEqual({ treatment: 'b', team: teamColorOf('player-abc'), sigil: teamSigilOf('player-abc') });
  });

  it('with the livery unset, the request is exactly as before', () => {
    expect(run(undefined)).toEqual([['fighter', undefined, true, false, undefined]]);
  });
});
