/**
 * Macro terrain v2 (room option `cutField`): the game client's cut field,
 * wired to its mirror and predWorld. The chunks near the local ship are cut
 * from the welcome's seed (none ride the wire, #16) in the page's art bake
 * pool, shared with ship bakes. docs/architecture/macro-terrain.md.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PhysicsWorld } from '@core/physics/World';
import { CutFieldClient, type ChunkCutter } from './CutFieldClient.js';
export type { CutFieldSummary } from './CutFieldClient.js';

export interface CutFieldHost {
  gameClock(): { now(): number };
  predWorld(): PhysicsWorld | null;
  readonly mirror: RenderMirror;
}

export function createGameCutField(host: CutFieldHost): CutFieldClient {
  // The bake pool loads lazily: a static import would pull its Worker URL into
  // every module that imports the client (Vite can't parse it under vitest).
  // Until it loads, a chunk is cut inline.
  let cutter: ChunkCutter | null = null;
  if (typeof Worker !== 'undefined') {
    void import('../render/art/ArtService').then((m) => { cutter = m.pageBakeRunner(); }, () => {});
  }
  const { mirror } = host;
  return new CutFieldClient({
    gameClock: { now: () => host.gameClock().now() },
    predWorld: () => host.predWorld(),
    // The piloted ship, or while spectating our own parked hull (spectate
    // leaves it parked in `ships`, keyed by shipInstanceId), so the field
    // stays loaded around it.
    // A free-flying spectator camera is not followed yet (its pose lives in
    // the renderer).
    localPose: () => {
      const localId = mirror.localPlayerId;
      if (!localId) return null;
      const own = mirror.ships.get(localId);
      if (own) return own;
      for (const s of mirror.ships.values()) if (s.ownerPlayerId === localId) return s;
      return null;
    },
    draw: {
      setFieldChunk: (cx, cy, outlines, ore = null, bodies = null, moved = null) => {
        (mirror.pendingFieldChunks ??= []).push({ cx, cy, outlines, ore, bodies, moved });
      },
    },
    cutter: () => cutter,
  });
}
