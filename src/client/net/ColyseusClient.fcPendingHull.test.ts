/**
 * Weapon strip across a sector swap (#13 — failing test first).
 *
 * Film 2026-11-26 (Ancients' gate, Sol Prime → Vega Reach): the PRIMARY strip
 * vanished for ~2 s after arrival. The new room holds the hull pending
 * (`isActive` false) until `client_ready`, and the own-ship slice leaves out
 * `groups` while the hull is pending, so the client applied "no groups" and
 * the strip hid. The groups are the ship's, not the room's: while the own hull
 * is pending they stay (locks from the old sector dropped), and the first real
 * slice replaces them.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

type Groups = ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number }> }>;
type Internals = { mirror: RenderMirror; fc: { applyFcGroups(groups: Groups | undefined): void } };

const own = (isActive: boolean) => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive, ownerPlayerId: 'p-me' });

describe('weapon groups while the own hull is pending (sector swap)', () => {
  it('keeps the strip (without old-sector locks) until the hull goes active, then takes the real slice', () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.mirror.localPlayerId = 'p-me';
    c.mirror.ships.set('p-me', own(true));
    c.fc.applyFcGroups([{ id: 'primary', m: 0, l: [{ t: 'p:old-sector-ship', s: 2, p: 100 }] }]);
    expect(useUIStore.getState().fcGroups.map((g) => g.id)).toEqual(['primary']);

    // Arrived in the new room: hull pending, no groups in the slice.
    c.mirror.ships.set('p-me', own(false));
    c.fc.applyFcGroups(undefined);
    c.fc.applyFcGroups(undefined);
    const held = useUIStore.getState().fcGroups;
    expect(held.map((g) => g.id), 'PRIMARY stays on screen').toEqual(['primary']);
    expect(held[0]!.locks, 'locks from the old sector are gone').toEqual([]);
    expect(c.mirror.localGroups![0]!.l).toEqual([]);

    // client_ready: the hull is active and the server's groups arrive.
    c.mirror.ships.set('p-me', own(true));
    c.fc.applyFcGroups([{ id: 'primary', m: 1, l: [] }]);
    expect(useUIStore.getState().fcGroups[0]!.mode).toBe('manual');
  });

  it('an active hull with no groups still clears the strip', () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.mirror.localPlayerId = 'p-me';
    c.mirror.ships.set('p-me', own(true));
    c.fc.applyFcGroups([{ id: 'primary', m: 0, l: [] }]);
    c.fc.applyFcGroups(undefined);
    expect(useUIStore.getState().fcGroups).toEqual([]);
  });
});
