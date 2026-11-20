/**
 * Field rock cut, slice 1C-b, client side: the welcome hands the room's
 * cut-field options (the field client's, cut from the welcome's seed and
 * clearings) to the wreck geometry store BEFORE the wreck list, so a broken
 * field rock's wreck (a late joiner's too) rebuilds; and to the render
 * mirror (`wreckField`), from which the renderer's own store (maybe in the
 * worker, a fresh clone each frame) takes them, value-compared.
 */
import { describe, expect, it } from 'vitest';
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { FRACTURE_ALGO_VERSION } from '@core/destruction/fractureHull';
import { rocksInChunk } from '@core/terrain/fieldLayout';
import { cutFieldOpts, fieldRockBody } from '@core/terrain/chunkStreamer';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor } from '@shared-types/messages/wreckDescriptor';
import { registerWelcomeHandlers, type WelcomeTarget } from './welcomeHandlers';
import { WreckGeometryStore } from '../wreckGeometryStore';

const FIELD = cutFieldOpts('test-seed', [{ x: 1000, y: 0, r: 500 }]);
const ROCK = rocksInChunk(FIELD, 15, 0)[0]!;
const DESC: WreckDescriptor = {
  wreckId: 9, parentKind: WRECK_ROCK_PARENT_KIND, seed: 5, killX: 0, killY: 0, killBlowDamage: 0,
  recentDamageRate: 0, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION, cutKind: 'slice', cutAng: 0,
  rock: { id: `f${ROCK.key}`, shape: 0, r: fieldRockBody(ROCK).radius, fk: ROCK.key },
};

function target(field: typeof FIELD | null): { t: WelcomeTarget; wrecks: WreckGeometryStore } {
  const wrecks = new WreckGeometryStore();
  let opts: typeof FIELD | null = null;
  const t = {
    mirror: {} as RenderMirror,
    clock: { now: () => 0 },
    gameClock: { at: (n: number) => n },
    // The field client cuts its options from the welcome's seed.
    cutField: { setSeed: (seed: string | null) => { opts = seed !== null ? field : null; }, get fieldOpts() { return opts; } },
    wrecks,
    shellTiming: { onWelcome: () => {} },
    room: null, webrtcEnabled: false, dataChannelTransport: null, storedPlayerId: null,
    shellEvents: false, serverTickAtWelcome: 0, welcomePerfNow: 0, clockAnchorServerTick: 0, clockAnchorPerfNow: 0,
    anchorInitialised: false, anchorFreshAtMs: 0, inputTick: 0, lastSentInputState: null, lastSentInputAtMs: 0,
    pendingPilotSwapShipId: null, pilotSwapGlidePending: false,
    onPlayerId: () => {}, rekeyOwnShipFromHull: () => {}, tryInitPredWorld: () => {},
  } as unknown as WelcomeTarget;
  return { t, wrecks };
}

function welcome(t: WelcomeTarget, msg: Record<string, unknown>): void {
  let handler: ((raw: unknown) => void) | undefined;
  const room = { onMessage: (type: string, cb: (raw: unknown) => void) => { if (type === 'welcome') handler = cb; } } as unknown as Room;
  registerWelcomeHandlers(room, { welcome: t });
  handler!({ type: 'welcome', playerId: 'p1', serverTick: 10, sectorKey: null, shipInstanceId: '', ...msg });
}

describe('welcome → wreck store field (slice 1C-b)', () => {
  it('the welcome sets the wreck store field', () => {
    const { t, wrecks } = target(FIELD);
    welcome(t, { cutField: { seed: 'test-seed', clearings: [{ x: 1000, y: 0, r: 500 }] }, subcapWrecks: true, wrecks: [DESC] });
    expect(wrecks.field).toBe(FIELD);
    expect(t.mirror.wreckField).toBe(FIELD);
    // The late joiner's field rock wreck resolves at once.
    expect(wrecks.piece(9, 0)).not.toBeNull();

    // The renderer's own store: a value-equal clone (the worker's) is no change.
    const r = new WreckGeometryStore();
    r.setField(FIELD);
    const before = r.field;
    r.setField(structuredClone(FIELD));
    expect(r.field).toBe(before);
    r.setField(cutFieldOpts('other-seed'));
    expect(r.field).not.toBe(before);

    // A welcome without a field clears it.
    const none = target(null);
    welcome(none.t, {});
    expect(none.wrecks.field).toBeNull();
    expect(none.t.mirror.wreckField).toBeNull();
  });
});
