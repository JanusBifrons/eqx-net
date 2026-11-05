/**
 * Machined turrets heap-delta lock (invariant #14): 24 ships turning their
 * baked guns (lit by world rotation), toggling aim guides, and firing (shots
 * matched to guns, held beams, recoil / flash / heat) must not allocate per
 * frame.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const frames = Array.from({ length: 16 }, () => Texture.WHITE);
const art = (): ShipArt => ({ frames, w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

describe('Machined turrets heap-delta', () => {
  it('100 000 mount updates on 24 ships grow the heap < 150 KB', () => {
    const ready = (job: BakeJob): ArtHandle => ({ key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null, fx: { tex: Texture.WHITE, frames: [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE], w: 1, h: 1 } });
    const service = { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService;
    const mvm = new MountVisualManager();
    mvm.setArt({ art: service, handles: new Map(), sunAz: 0.4, turrets: true });
    const kinds = ['gunship', 'interceptor', 'missile-frigate', 'fighter'];
    const ids: string[] = [], hulls: MachinedShipSprite[] = [];
    for (let i = 0; i < 24; i++) { ids.push(`s${i}`); const h = new MachinedShipSprite(art()); hulls.push(h); mvm.ensureForShip(ids[i]!, kinds[i % 4], h); }
    const mountsOf = kinds.map((k) => getShipKind(k).mounts!);
    const angles = [0, 0];
    const aim = ['wing-l', 'wing-r'];
    const frame = (f: number): void => {
      mvm.setLocalAim('s1', (f >> 5) & 1 ? aim : undefined);
      mvm.setFrame(f * 16.7, (f >> 9) & 1 ? 'low' : 'high');
      if (f % 7 === 0) mvm.noteShotNear(ids[f % 24]!, hulls[f % 24]!.x, hulls[f % 24]!.y);
      if (f % 5 === 0) mvm.noteBeam(ids[(f + 1) % 24]!, 'wing-l');
      angles[0] = Math.sin(f * 0.01) * 0.4; angles[1] = -angles[0];
      for (let i = 0; i < 24; i++) {
        hulls[i]!.rotation = f * 0.003 + i;
        mvm.applyMountAngles(ids[i]!, mountsOf[i % 4]!, angles);
      }
    };
    for (let f = 0; f < 500; f++) frame(f);
    const before = postGcHeap();
    for (let f = 0; f < 4200; f++) frame(f);
    expect(postGcHeap() - before).toBeLessThan(150 * 1024);
  });
});
