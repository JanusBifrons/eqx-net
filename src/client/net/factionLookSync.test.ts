/**
 * Galaxy map 0b — a look claimed by player A reaches player B's renderer on
 * both render paths. Main thread: B's client hears `faction_look_claimed` and
 * `ownerLivery(A)` (the renderer's one livery resolver) repaints. Desktop
 * worker: `WorkerRendererClient.update` posts SET_FACTION_LOOKS (structured-
 * cloned, as the real boundary does), and the worker's own registry copy,
 * applying it as `renderer.worker.ts` does, resolves the same livery.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { onFactionLookClaimed } from './factionLookSync.js';
import { ownerLivery } from '../render/art/shipArtSprites.js';
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient.js';
import type { MainToWorkerMsg, SetFactionLooksMsg } from '../render/worker/protocol.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import { LIVERY_EDGES, PLAYER_LIVERY, claimFactionLook, setFactionLooks } from '../../shared-types/factions.js';

const A = 'player-a';
const SLOT = 5;
const SIGIL = 0x1f4;
const CLAIMED = { team: PLAYER_LIVERY[SLOT], sigil: (SLOT << 12) | SIGIL, edge: LIVERY_EDGES[SIGIL % 3] };

function claimedMsg(): unknown {
  return { type: 'faction_look_claimed', look: { factionId: A, colorSlot: SLOT, sigil: SIGIL } };
}

afterEach(() => setFactionLooks([]));

describe('faction look sync — main-thread renderer', () => {
  it("A's claim, heard by B's client, changes the livery B's renderer resolves", () => {
    const before = { ...ownerLivery(A) };
    expect(before).not.toEqual(CLAIMED);
    onFactionLookClaimed(claimedMsg());
    expect(ownerLivery(A)).toEqual(CLAIMED);
  });

  it('a malformed broadcast is dropped', () => {
    const before = { ...ownerLivery(A) };
    onFactionLookClaimed({ type: 'faction_look_claimed', look: { factionId: A, colorSlot: 99, sigil: SIGIL } });
    onFactionLookClaimed({ type: 'faction_look_claimed', look: { factionId: A, colorSlot: SLOT, sigil: SIGIL }, extra: 1 });
    expect(ownerLivery(A)).toEqual(before);
  });
});

describe('faction look sync — desktop renderer worker', () => {
  function harness(): { client: WorkerRendererClient; looks: SetFactionLooksMsg[] } {
    const client = new WorkerRendererClient();
    const looks: SetFactionLooksMsg[] = [];
    const fake = {
      postMessage(msg: MainToWorkerMsg): void {
        if (msg.type === 'SET_FACTION_LOOKS') looks.push(structuredClone(msg));
      },
    };
    (client as unknown as { worker: unknown }).worker = fake;
    return { client, looks };
  }
  const mirror = (): RenderMirror => ({ ships: new Map(), projectiles: new Map(), swarm: new Map() }) as unknown as RenderMirror;

  it("A's claim reaches the worker's registry copy and its renderer resolves the same livery", () => {
    const { client, looks } = harness();
    client.update(mirror());
    looks.length = 0;
    onFactionLookClaimed(claimedMsg());
    client.update(mirror());
    expect(looks).toHaveLength(1);
    client.update(mirror());
    expect(looks, 'posted once per change, not per frame').toHaveLength(1);

    // The worker's module copy starts without the claim, then applies the post.
    setFactionLooks([]);
    expect(ownerLivery(A)).not.toEqual(CLAIMED);
    setFactionLooks(looks[0]!.looks);
    expect(ownerLivery(A)).toEqual(CLAIMED);
  });

  it('a re-claim (A moves to a new pair) is posted too', () => {
    const { client, looks } = harness();
    onFactionLookClaimed(claimedMsg());
    client.update(mirror());
    expect(claimFactionLook(A, SLOT, SIGIL + 1)).toBe('ok');
    client.update(mirror());
    expect(looks.at(-1)!.looks).toEqual([{ factionId: A, colorSlot: SLOT, sigil: SIGIL + 1 }]);
  });
});
