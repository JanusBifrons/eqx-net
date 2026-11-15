/**
 * The art warm-up bakes ships in the livery the renderer will ask for: with
 * the livery on by default, a plain warm-up bake would go unused and every
 * ship's first sight in play would bake mid-game. Lock: each warm-up ship
 * job's bake key equals the key `shipHandleFor` requests for an NPC ship of
 * that kind (owner = the kind's allegiance), with and without turret rings.
 */
import { describe, expect, it } from 'vitest';
import { allegianceOfKind } from '../../../shared-types/shipKinds.js';
import { bakeKey, type BakeJob } from './bake.js';
import type { ArtHandle, ArtService } from './ArtService.js';
import type { Livery } from './fields.js';
import { ownerLivery, shipHandleFor, type ShipArtCtx } from './shipArtSprites.js';
import { warmUpJobs } from './warmUp.js';

/** A stand-in ArtService whose `ship` builds the job exactly as the real one does. */
function fakeArt(): ArtService {
  return {
    ship(id: string, paint?: number, _urgent = true, rings = false, dead = false, livery?: Livery): ArtHandle {
      const job: BakeJob = { type: 'ship', id, paint, ...(rings ? { rings } : {}), ...(dead ? { dead } : {}), ...(livery ? { livery } : {}) };
      return { job } as unknown as ArtHandle;
    },
  } as unknown as ArtService;
}

describe('warm-up bakes the livery the renderer asks for', () => {
  for (const fx of [false, true]) {
    it(`fx=${fx}: every warm-up ship key matches shipHandleFor's request`, () => {
      const jobs = warmUpJobs(fx, 'b8').filter((j): j is Extract<BakeJob, { type: 'ship' }> => j.type === 'ship');
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) {
        const actx = { art: fakeArt(), handles: new Map(), turrets: fx, livery: 'b8' } as unknown as ShipArtCtx;
        const h = j.id === 'cargo-pod'
          ? shipHandleFor(actx, 'k', j.id, undefined)
          : (() => { const lv = ownerLivery(allegianceOfKind(j.id)); return shipHandleFor(actx, 'k', j.id, undefined, false, lv.team, lv.sigil, lv.edge); })();
        expect(bakeKey(j), j.id).toBe(bakeKey(h!.job));
      }
    });
  }

  it('without a livery the warm-up is the plain set (unchanged)', () => {
    for (const j of warmUpJobs(false)) if (j.type === 'ship') expect(j.livery).toBeUndefined();
  });
});
