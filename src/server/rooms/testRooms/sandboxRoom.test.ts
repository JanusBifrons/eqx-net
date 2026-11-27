/**
 * Sandbox room (docs/features/sandbox.md): client create options never reach
 * the room (B3), and only one instance can exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectorRoom } from '../SectorRoom.js';

// The real SectorRoom needs the schema decorators and a physics worker; the
// sandbox only overrides onCreate/onDispose, so a bare base stands in.
vi.mock('../SectorRoom.js', () => ({
  SectorRoom: class {
    async onCreate(_o: unknown): Promise<void> { /* stub */ }
    onDispose(): void { /* stub */ }
  },
}));
import { isSealedSectorKey } from '../sealedSectors.js';
import { SANDBOX_OPTS, SANDBOX_ROOM_NAME, SandboxRoom, defineSandboxRoom } from './sandboxRoom.js';

describe('sandbox room', () => {
  const created: SandboxRoom[] = [];
  afterEach(() => {
    for (const r of created.splice(0)) r.onDispose();
    vi.restoreAllMocks();
  });

  function stubSectorRoom(): { create: ReturnType<typeof vi.fn> } {
    const create = vi.spyOn(SectorRoom.prototype, 'onCreate').mockResolvedValue(undefined);
    vi.spyOn(SectorRoom.prototype, 'onDispose').mockImplementation(() => undefined);
    return { create: create as unknown as ReturnType<typeof vi.fn> };
  }

  function room(): SandboxRoom {
    const r = Object.create(SandboxRoom.prototype) as SandboxRoom;
    created.push(r);
    return r;
  }

  it('is sealed, free-build, unsaved, a deck room, empty and NOT testMode', () => {
    expect(isSealedSectorKey(SANDBOX_OPTS.sectorKey)).toBe(true);
    expect(SANDBOX_OPTS).toMatchObject({ sealed: true, freeBuilds: true, persistSector: false, deck: true, droneCount: 0, asteroidConfig: [] });
    expect('testMode' in SANDBOX_OPTS).toBe(false);
  });

  it('ignores client create options: onCreate gets SANDBOX_OPTS only', async () => {
    const { create } = stubSectorRoom();
    await room().onCreate({ testMode: true, tickBurnMs: 50, timeScale: 4, sealed: false, sectorKey: 'galaxy-home' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual({ ...SANDBOX_OPTS, asteroidConfig: [] });
  });

  it('refuses a second instance while one is live, allows a new one after dispose', async () => {
    const { create } = stubSectorRoom();
    const first = room();
    await first.onCreate({});
    await expect(room().onCreate({})).rejects.toThrow(/only one/);
    expect(create).toHaveBeenCalledTimes(1);
    first.onDispose();
    await room().onCreate({});
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a failed create frees the slot', async () => {
    const create = vi.spyOn(SectorRoom.prototype, 'onCreate').mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    vi.spyOn(SectorRoom.prototype, 'onDispose').mockImplementation(() => undefined);
    await expect(room().onCreate({})).rejects.toThrow('boom');
    await room().onCreate({});
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('registers as `sandbox` with no define options and no filterBy', () => {
    const define = vi.fn();
    defineSandboxRoom({ define });
    expect(define).toHaveBeenCalledWith(SANDBOX_ROOM_NAME, SandboxRoom);
    expect(SANDBOX_ROOM_NAME).toBe('sandbox');
  });
});
