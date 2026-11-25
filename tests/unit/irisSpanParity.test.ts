/**
 * Invariant #15 — the Ancients' gate's seal (teleporter redesign A3): the
 * server's iris walls (`TeleportPadRiders.forIrisSpan`, what `spawnIris` posts
 * as SPAWN_WALL at the gate's position) and the client's derived walls
 * (`visitDerivedWalls`, drawn and collided with by the prediction world) must
 * be the same segments, solid only while SEALED. Fails if the sides disagree.
 */
import { describe, expect, it } from 'vitest';
import { TeleportPadRiders, type TeleportRiderHost } from '../../src/server/rooms/features/teleportMessages.js';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { IRIS_KEY_STRIDE, visitDerivedWalls } from '../../src/client/structures/derivedWalls.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { TELEPORTER_KINDS, TP_PHASE, padIrisSpanCount } from '../../src/shared-types/teleport.js';

type Seg = [number, number, number, number];

function serverSpans(kind: string, x: number, y: number): Seg[] {
  const out: Seg[] = [];
  new TeleportPadRiders({} as TeleportRiderHost).forIrisSpan(
    { id: 'g', kind, x, y } as unknown as StructureRecord,
    (_id, s) => out.push([x + s.ax, y + s.ay, x + s.bx, y + s.by]),
  );
  return out;
}

function clientWalls(kind: string, x: number, y: number, phase: number) {
  const st = { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, teleport: { phase } } as unknown as StructureRenderState;
  const sw = { x, y, vx: 0, vy: 0, angle: 0, kind: 2, radius: 50, shipKind: kind } as unknown as SwarmRenderState;
  const out: Array<{ seg: Seg; blocking: boolean; key: number }> = [];
  visitDerivedWalls(new Map([[7, st]]), new Map([[7, sw]]), {
    wall: (key, ax, ay, bx, by, blocking) => out.push({ seg: [ax, ay, bx, by], blocking, key }),
  });
  return out;
}

describe('iris span parity (server walls = client derived walls)', () => {
  it('every pad kind: the same segments on both sides', () => {
    for (const kind of TELEPORTER_KINDS) {
      const server = serverSpans(kind, 1234, -567);
      const client = clientWalls(kind, 1234, -567, TP_PHASE.SEALED).map((w) => w.seg);
      expect(client, kind).toEqual(server);
      expect(server.length, kind).toBe(padIrisSpanCount(kind));
    }
  });

  it('the Ancients\' gate: solid only while SEALED, with distinct keys', () => {
    for (const phase of [TP_PHASE.IDLE, TP_PHASE.ARMED, TP_PHASE.CLOSING, TP_PHASE.SEALED, TP_PHASE.OPEN]) {
      const walls = clientWalls('alien_gate', 0, 0, phase);
      expect(walls.length).toBe(padIrisSpanCount('alien_gate'));
      expect(walls.every((w) => w.blocking === (phase === TP_PHASE.SEALED))).toBe(true);
      expect(new Set(walls.map((w) => w.key)).size).toBe(walls.length);
    }
    for (const kind of TELEPORTER_KINDS) expect(padIrisSpanCount(kind)).toBeLessThan(IRIS_KEY_STRIDE);
  });
});
