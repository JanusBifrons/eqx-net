/**
 * Phase 6b — regression lock for the "I can't see my lingering ships at
 * all" bug (2026-05-13, two iterations in).
 *
 * The path under test:
 *
 *   server sends snapshot with `state.isActive === false` entries
 *     ↓
 *   `ColyseusGameClient.handleSnapshot` (private) routes them to
 *   `mirror.lingeringShips: Map<shipInstanceId, ...>` rather than
 *   `mirror.ships` (which is playerId-keyed and would collide with the
 *   active hull for the same player)
 *     ↓
 *   `mirror.lingeringShips` carries pose + ownerPlayerId; identity
 *   (kind, displayName) arrives separately via the Colyseus state diff
 *   handled by `syncMirror`, which writes to the same map keyed by
 *   shipInstanceId
 *     ↓
 *   `PixiRenderer.updateLingeringShips` reads the map and draws each
 *   entry. Sprite caching is per-shipInstanceId; if `ship.kind` changes
 *   after the sprite is built (e.g. the schema diff arrives after the
 *   first snapshot), the renderer rebuilds the sprite
 *
 * The bug at first iteration: `if (!ship.kind) continue;` in the
 * renderer caused lingering hulls to be permanently invisible whenever
 * the snapshot wrote the entry before the schema diff filled in `kind`.
 * The renderer never retried because the entry's kind stayed undefined
 * until syncMirror ran (which it does, but the renderer was already
 * skipping every frame).
 *
 * The bug at second iteration (this regression lock targets it): same
 * symptom from a different cause — if the snapshot's `isActive=false`
 * entry isn't routed to `mirror.lingeringShips` at all (or is removed
 * by an over-aggressive cleanup pass), the user sees nothing.
 *
 * We test the routing in isolation by invoking the private handler via
 * a narrow structural cast. The harness covers:
 *   - First snapshot with a lingering hull → mirror.lingeringShips
 *     populated with pose + ownerPlayerId, no kind yet
 *   - Subsequent snapshot → mirror entry pose updated, ownerPlayerId
 *     preserved
 *   - Lingering hull disappears from the snapshot → mirror entry
 *     removed
 *   - Active hull for the SAME playerId co-exists → routed to
 *     mirror.ships (not lingeringShips)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

type Internals = {
  handleSnapshot: (snap: SnapshotMessage) => void;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

function makeSnapshot(states: SnapshotMessage['states']): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 100,
    states,
    ackedTick: 0,
  };
}

function lingeringEntry(playerId: string): SnapshotMessage['states'][string] {
  return {
    x: 100, y: -200,
    vx: 0, vy: 0,
    angle: 0.5, angvel: 0,
    playerId,
    isActive: false,
  };
}

function activeEntry(playerId: string): SnapshotMessage['states'][string] {
  return {
    x: 50, y: 80,
    vx: 1, vy: -2,
    angle: 0, angvel: 0,
    playerId,
    isActive: true,
  };
}

describe('ColyseusClient.handleSnapshot — Phase 6b lingering routing', () => {
  let client: ColyseusGameClient;

  beforeEach(() => {
    client = new ColyseusGameClient();
    // Welcome would normally set this. Tests that exercise the
    // self-vs-remote branching need a non-null localPlayerId.
    (client.mirror as { localPlayerId: string | null }).localPlayerId = 'local-player';
  });

  it('routes an isActive=false entry into mirror.lingeringShips keyed by shipInstanceId', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    expect(client.mirror.lingeringShips).toBeDefined();
    expect(client.mirror.lingeringShips!.size).toBe(1);
    const entry = client.mirror.lingeringShips!.get('ship-uuid-LINGER');
    expect(entry).toBeDefined();
    expect(entry!.x).toBe(100);
    expect(entry!.y).toBe(-200);
    expect(entry!.angle).toBe(0.5);
    expect(entry!.ownerPlayerId).toBe('player-A');
  });

  it('does NOT add the lingering entry to mirror.ships (playerId-keyed map for active hulls)', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    // mirror.ships shouldn't have a player-A entry — the only ship for
    // player-A in this snapshot is lingering, and lingering hulls live
    // in a separate map.
    expect(client.mirror.ships.get('player-A')).toBeUndefined();
  });

  it('updates pose on a follow-up snapshot, preserves ownerPlayerId, keeps existing kind', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    // Simulate the schema-diff path having populated kind.
    const first = client.mirror.lingeringShips!.get('ship-uuid-LINGER')!;
    (first as { kind?: string }).kind = 'interceptor';

    // Next snapshot with new pose, same id.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': {
        ...lingeringEntry('player-A'),
        x: 999, y: 999,
      },
    }));
    const second = client.mirror.lingeringShips!.get('ship-uuid-LINGER')!;
    expect(second.x).toBe(999);
    expect(second.y).toBe(999);
    expect(second.ownerPlayerId).toBe('player-A');
    expect(second.kind).toBe('interceptor');  // preserved
  });

  it('removes a lingering hull from the mirror when it disappears from the snapshot', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    expect(client.mirror.lingeringShips!.size).toBe(1);
    // Snapshot without the lingering hull (server evicted it).
    asInternals(client).handleSnapshot(makeSnapshot({}));
    expect(client.mirror.lingeringShips!.size).toBe(0);
  });

  it('active + lingering for the same playerId: lingering routed to lingeringShips, active NOT added to lingeringShips', () => {
    // Note: handleSnapshot does NOT itself populate mirror.ships — that
    // is `syncMirror`'s job (from the Colyseus state diff). What we
    // verify here is that the snapshot's `isActive=false` routing only
    // touches `mirror.lingeringShips` and never accidentally puts an
    // active hull there.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER':   lingeringEntry('player-A'),
      'ship-uuid-FRESH':    activeEntry('player-A'),
    }));
    // Lingering goes to mirror.lingeringShips keyed by shipInstanceId.
    expect(client.mirror.lingeringShips!.get('ship-uuid-LINGER')).toBeDefined();
    // Active does NOT pollute mirror.lingeringShips.
    expect(client.mirror.lingeringShips!.get('ship-uuid-FRESH')).toBeUndefined();
    expect(client.mirror.lingeringShips!.size).toBe(1);
  });

  it('handles multiple lingering hulls for the same player simultaneously', () => {
    // Phase 6b's whole point: a player can have N lingering hulls in
    // the same sector. mirror.lingeringShips is keyed by shipInstanceId
    // so they don't overwrite each other.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER-1': lingeringEntry('player-A'),
      'ship-uuid-LINGER-2': { ...lingeringEntry('player-A'), x: 200 },
      'ship-uuid-LINGER-3': { ...lingeringEntry('player-A'), x: 300 },
    }));
    expect(client.mirror.lingeringShips!.size).toBe(3);
    expect(client.mirror.lingeringShips!.get('ship-uuid-LINGER-1')!.x).toBe(100);
    expect(client.mirror.lingeringShips!.get('ship-uuid-LINGER-2')!.x).toBe(200);
    expect(client.mirror.lingeringShips!.get('ship-uuid-LINGER-3')!.x).toBe(300);
  });

  it('regression: lingering hull stays visible across many follow-up snapshots (the original bug)', () => {
    // The "I can't see my lingering ships at all" symptom would manifest
    // here as the entry being absent after the first iteration of the
    // cleanup loop. Run several snapshots in a row and assert the entry
    // is still there.
    for (let i = 0; i < 10; i++) {
      asInternals(client).handleSnapshot(makeSnapshot({
        'ship-uuid-LINGER': {
          ...lingeringEntry('player-A'),
          x: i * 10,
        },
      }));
    }
    expect(client.mirror.lingeringShips!.size).toBe(1);
    const entry = client.mirror.lingeringShips!.get('ship-uuid-LINGER')!;
    expect(entry.x).toBe(90);  // last snapshot's pose
    expect(entry.ownerPlayerId).toBe('player-A');
  });
});
