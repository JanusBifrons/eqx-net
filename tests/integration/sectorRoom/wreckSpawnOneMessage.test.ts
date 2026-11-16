/**
 * Pieces of ONE wreck reach the physics worker in ONE message, so they all
 * start on the same physics step (story: docs/architecture/capital-destruction.md
 * "How pieces reach the worker").
 *
 * Found 2026-11-16: `subcapWrecks.test.ts` "a missile-frigate's pieces stand
 * clearly apart 1 s after the break" failed under host load (1.34 radii vs
 * the 1.5 bar) and passed alone; one forced seed varied ±0.2 radii run to
 * run. Each piece's SPAWN_OBSTACLE (and the dying body's DESPAWN, and a
 * capital's per-piece WRECK_KICK) was its own `postMessage`, and the worker
 * thread handles each message as its own task with its step timer in
 * between: on a loaded host it steps between two pieces, so one piece of
 * a ship killed at speed is a step ahead of its neighbour (or has its kick
 * a step early), and the wreck parts differently each run.
 *
 * This test watches the real worker boundary (`Worker.prototype.postMessage`)
 * while a wreck is made and counts the messages that carry its pieces.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

const WRECK_KIND = 4;

interface Cmd { type: string; obstacleId?: string; playerId?: string; entityId?: string; cmds?: Cmd[] }

/** The commands a message carries (a BATCH's, or the message itself). */
function cmdsOf(m: Cmd): Cmd[] {
  return m.type === 'BATCH' && Array.isArray(m.cmds) ? m.cmds : [m];
}

describe('SectorRoom integration — one wreck, one worker message', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (harness) await harness.cleanup();
  }, 10_000);

  async function boot(opts: Record<string, unknown>): Promise<SectorRoom['_internals']> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], ...opts,
    });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -40_000, spawnY: -40_000 });
    return (harness.getServerRoom() as unknown as SectorRoom)._internals;
  }

  /** Record every message posted to a physics worker from now on (cloned
   *  at post time: postMessage clones synchronously, senders reuse objects). */
  function tapWorker(): Cmd[] {
    const sent: Cmd[] = [];
    const orig = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, msg: unknown, ...rest: unknown[]) {
      sent.push(structuredClone(msg) as Cmd);
      return (orig as (...a: unknown[]) => void).call(this, msg, ...rest);
    });
    return sent;
  }

  it('a sub-cap death: every piece spawns, with the hull despawn, in one message', async () => {
    const internal = await boot({ subcapWrecks: true });
    expect(internal.spawnTestDrone('mf', 3000, 0, 'missile-frigate')).toBe(true);
    await harness.advance(100);
    const at = internal.wreckState('mf')!;
    const sent = tapWorker();
    internal.applyDamage('mf', 'shooter-x', 1e7, at.x, at.y);
    const ids = new Set([...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    const carrying = sent.filter((m) => cmdsOf(m).some((c) => c.type === 'SPAWN_OBSTACLE' && ids.has(c.obstacleId ?? '')));
    expect(carrying.length, 'worker messages carrying this wreck\'s piece spawns').toBe(1);
    const cmds = cmdsOf(carrying[0]!);
    expect(cmds.filter((c) => c.type === 'SPAWN_OBSTACLE' && ids.has(c.obstacleId ?? '')).length).toBe(ids.size);
    // The dead hull leaves in the same message, before the pieces arrive.
    const despawn = cmds.findIndex((c) => c.type === 'DESPAWN' && c.playerId === 'mf');
    expect(despawn, 'the dying hull\'s DESPAWN rides the same message').toBeGreaterThanOrEqual(0);
    expect(despawn).toBeLessThan(cmds.findIndex((c) => c.type === 'SPAWN_OBSTACLE'));
  }, 20_000);

  it('a capital: every piece gets its separating kick in one message after the crack hold', async () => {
    const internal = await boot({ capitalWrecks: true });
    expect(internal.spawnTestDrone('bb', 6000, 0, 'battleship')).toBe(true);
    await harness.advance(100);
    const at = internal.wreckState('bb')!;
    internal.applyDamage('bb', 'shooter-x', 1e7, at.x, at.y);
    const ids = new Set([...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    const sent = tapWorker();
    await harness.advance(WRECK_CRACK_MS + 300);
    const carrying = sent.filter((m) => cmdsOf(m).some((c) => c.type === 'WRECK_KICK' && ids.has(c.entityId ?? '')));
    expect(carrying.length, 'worker messages carrying this wreck\'s kicks').toBe(1);
    expect(cmdsOf(carrying[0]!).filter((c) => c.type === 'WRECK_KICK').length).toBe(ids.size);
  }, 20_000);
});
