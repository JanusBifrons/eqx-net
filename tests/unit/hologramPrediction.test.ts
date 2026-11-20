/**
 * Hologram pass-through, client side (base loop 3F2): the local ship's
 * prediction treats a structure as passable exactly when the server does.
 *
 * Two real Rapier worlds side by side:
 *  - the SERVER world builds the structure body the way `SwarmSpawner.
 *    spawnStructure` + the worker do (hull points, gate parts, locked; a
 *    blueprint in `BLUEPRINT_COLLISION_GROUPS` with no rig; a solid one in the
 *    default groups with its rig);
 *  - the CLIENT predWorld builds it through the real client factory leaf from
 *    the swarm entry plus its decoded room-state row (`ghostBody`).
 * The same ship flies at it in both; any divergence is a correction.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { BLUEPRINT_COLLISION_GROUPS } from '../../src/core/physics/collisionGroups.js';
import { isStructureBodySolid, structureBodyCollisionGroups } from '../../src/core/structures/structureBody.js';
import { rigForStructureKind } from '../../src/core/articulation/rigCatalogue.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { SWARM_KIND_STRUCTURE } from '../../src/shared-types/swarmWireFormat.js';
import { structureHalfExtents, structureHullPoints } from '../../src/shared-types/structureKinds.js';
import { STRUCTURE_FLAG_BUILT, STRUCTURE_FLAG_GHOST_BODY } from '../../src/shared-types/structureStateWire.js';
import { decodeStructureState, emptyStructureRow } from '../../src/client/net/structureStateDecode.js';
import { ClientEntityFactory } from '../../src/client/net/entity/ClientEntityFactory.js';
import type { ClientSpawnCtx } from '../../src/client/net/entity/IClientEntityLeaf.js';

/** The LERP_THRESHOLD the reconciler treats as a correction is 0.05 u. */
const CORRECTION_U = 0.05;
/** The Capital carries a crane rig: a ghost must not have its solid parts either. */
const KIND = 'capital';
const RADIUS = 24;
const { hw } = structureHalfExtents(KIND, 0);

/** A room-state row as the client decodes it from `flags`. */
function row(flags: number): StructureRenderState {
  const out = emptyStructureRow();
  decodeStructureState({ flags, connTo: [] }, { ids: [], names: [] }, out, KIND);
  return out;
}

/** The server's structure body (SwarmSpawner + worker). */
function serverStructure(w: PhysicsWorld, id: string, x: number, ghost: boolean): void {
  w.spawnObstacle(id, x, 0, RADIUS, 3, structureHullPoints(KIND, RADIUS), 0, structureBodyCollisionGroups({ ghostBody: ghost }));
  w.lockBody(id);
  const rig = rigForStructureKind(KIND);
  if (!ghost && rig) w.attachRig(id, rig);
}

describe('hologram pass-through in client prediction (3F2)', () => {
  let server: PhysicsWorld;
  let client: PhysicsWorld;
  const leaf = new ClientEntityFactory().leafFor(SWARM_KIND_STRUCTURE)!;
  const structures = new Map<number, StructureRenderState>();
  let next = 0;

  beforeAll(async () => {
    server = await PhysicsWorld.create();
    client = await PhysicsWorld.create();
  });

  /** Spawn the structure in both worlds at a fresh x; returns its ctx + x. */
  function place(flags: number): { ctx: ClientSpawnCtx; x: number } {
    const id = 100 + next;
    const x = next++ * 50_000;
    structures.set(id, row(flags));
    serverStructure(server, `s-${id}`, x, (flags & STRUCTURE_FLAG_GHOST_BODY) !== 0);
    const entry = { x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: RADIUS, kind: SWARM_KIND_STRUCTURE, shipKind: KIND } as SwarmRenderState;
    const ctx: ClientSpawnCtx = {
      predWorld: client,
      aiController: { register: () => undefined, unregister: () => undefined } as unknown as ClientSpawnCtx['aiController'],
      structures,
      entityId: id,
      key: `swarm-${id}`,
      entry,
      registeredAiId: null,
    };
    leaf.spawnBody(ctx);
    leaf.onSync(ctx);
    return { ctx, x };
  }

  /** Fly a ship at the structure from the left in both worlds; returns the
   *  corrections, the server's final x and the ship id. */
  function flyAt(x: number, ticks: number, onTick?: (i: number) => void): { corrections: number; maxDrift: number; endX: number } {
    const id = `ship-${x}`;
    const start = x - hw - 300;
    for (const w of [server, client]) {
      w.spawnShip(id, start, 0, 'crossguard');
      w.setShipState(id, { x: start, y: 0, angle: 0, vx: 600, vy: 0 });
    }
    let corrections = 0;
    let maxDrift = 0;
    for (let i = 0; i < ticks; i++) {
      onTick?.(i);
      server.tick(1 / 60);
      client.tick(1 / 60);
      const s = server.getShipState(id)!;
      const c = client.getShipState(id)!;
      const d = Math.hypot(s.x - c.x, s.y - c.y);
      if (d > CORRECTION_U) corrections++;
      maxDrift = Math.max(maxDrift, d);
    }
    return { corrections, maxDrift, endX: server.getShipState(id)!.x };
  }

  const crossTicks = Math.ceil(((2 * hw + 900) / 600) * 60);

  it('the ghost flag rides the row: decoded to ghostBody, read by the shared predicate', () => {
    expect(isStructureBodySolid(row(0))).toBe(true);
    expect(isStructureBodySolid(row(STRUCTURE_FLAG_BUILT))).toBe(true);
    expect(row(STRUCTURE_FLAG_GHOST_BODY).ghostBody).toBe(true);
    expect(isStructureBodySolid(row(STRUCTURE_FLAG_GHOST_BODY))).toBe(false);
  });

  it('prediction matches the server through a hologram: the ship passes, no corrections', () => {
    const { x } = place(STRUCTURE_FLAG_GHOST_BODY);
    const r = flyAt(x, crossTicks);
    expect(r.corrections, `drift (max ${r.maxDrift.toFixed(3)} u)`).toBe(0);
    expect(r.endX).toBeGreaterThan(x + hw); // straight through
  });

  it('a built structure blocks prediction like the server', () => {
    const { x } = place(STRUCTURE_FLAG_BUILT);
    const r = flyAt(x, crossTicks);
    expect(r.corrections, `drift (max ${r.maxDrift.toFixed(3)} u)`).toBe(0);
    expect(r.endX).toBeLessThan(x - hw + 1); // stopped at its face
  });

  it('a hologram that turns solid blocks prediction from then on', () => {
    const { ctx, x } = place(STRUCTURE_FLAG_GHOST_BODY);
    // Solidify before the ship arrives, on both sides at the same tick.
    const r = flyAt(x, crossTicks, (i) => {
      if (i !== 5) return;
      server.setCollisionGroups(`s-${ctx.entityId}`, structureBodyCollisionGroups({}));
      server.attachRig(`s-${ctx.entityId}`, rigForStructureKind(KIND)!);
      structures.set(ctx.entityId, row(STRUCTURE_FLAG_BUILT));
      leaf.onSync(ctx);
    });
    expect(r.corrections, `drift (max ${r.maxDrift.toFixed(3)} u)`).toBe(0);
    expect(r.endX).toBeLessThan(x - hw + 1);
  });

  it('a body spawned solid before its row said ghost is rebuilt as a ghost', () => {
    const id = 999;
    const x = -50_000;
    structures.delete(id); // no row yet: the wire default, solid
    serverStructure(server, `s-${id}`, x, true);
    const ctx: ClientSpawnCtx = {
      predWorld: client,
      aiController: { register: () => undefined, unregister: () => undefined } as unknown as ClientSpawnCtx['aiController'],
      structures, entityId: id, key: `swarm-${id}`,
      entry: { x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: RADIUS, kind: SWARM_KIND_STRUCTURE, shipKind: KIND } as SwarmRenderState,
      registeredAiId: null,
    };
    leaf.spawnBody(ctx);
    structures.set(id, row(STRUCTURE_FLAG_GHOST_BODY));
    leaf.onSync(ctx);
    expect(client.hasShip(ctx.key)).toBe(true);
    const r = flyAt(x, crossTicks);
    expect(r.corrections, `drift (max ${r.maxDrift.toFixed(3)} u)`).toBe(0);
    expect(r.endX).toBeGreaterThan(x + hw);
    expect(BLUEPRINT_COLLISION_GROUPS).toBe(structureBodyCollisionGroups({ ghostBody: true }));
  });
});
