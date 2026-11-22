import { describe, it, expect } from 'vitest';
import { AiStructureTargets, type AiStructureTargetsHost } from './aiStructureTargets.js';
import { createRelationContext } from '../../../shared-types/relations.js';
import type { AiStructureView } from '../../../core/contracts/IAiBehaviour.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';

const OWNER = 'owner-1';
const ENEMY = 'enemy-1';
const RAIDED = 'raided-1';

function rec(id: string, owner: string, isConstructed = true): StructureRecord {
  return { id, owner, kind: 'capital', x: 10, y: 20, radius: 50, isConstructed } as unknown as StructureRecord;
}

function setup(recs: StructureRecord[], fleetOwners: string[]): { t: AiStructureTargets; npcCalls: string[] } {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const npcCalls: string[] = [];
  const host: AiStructureTargetsHost = {
    structures: () => ({ size: byId.size, all: () => byId.values(), get: (id) => byId.get(id) }),
    isHostileToDrones: (o) => o === RAIDED,
    health: () => 100,
    fleetSize: () => fleetOwners.length,
    fleetOwnerAt: (i) => fleetOwners[i]!,
    relationCtx: createRelationContext({
      hostileActs: { isHostile: (a, o) => a === OWNER && o === ENEMY },
    }),
    now: () => 0,
    npcHostileTo: (e) => { npcCalls.push(e); return true; },
  };
  return { t: new AiStructureTargets(host), npcCalls };
}

describe('AiStructureTargets — the AI structure view (capital fixes S6)', () => {
  it("lists a drone-raid structure and an AI-hull owner's enemy base, nothing else", () => {
    const { t } = setup(
      [rec('raid', RAIDED), rec('enemy', ENEMY), rec('mine', OWNER), rec('neutral', 'someone'), rec('unbuilt', ENEMY, false)],
      [OWNER, OWNER],
    );
    const out: AiStructureView[] = [];
    t.fill(out);
    expect(out.map((s) => [s.id, s.ownerFoeOnly])).toEqual([['raid', false], ['enemy', true]]);
    expect(out[1]!.owner).toBe(ENEMY);
    // Capital turret circles stay the raid list.
    expect(t.circles.map((c) => c.id)).toEqual(['raid']);
  });

  it('no AI-flown hulls: the raid list only (unchanged)', () => {
    const { t } = setup([rec('raid', RAIDED), rec('enemy', ENEMY)], []);
    const out: AiStructureView[] = [];
    t.fill(out);
    expect(out.map((s) => s.id)).toEqual(['raid']);
  });

  it('reuses its entries tick to tick (no per-tick allocation)', () => {
    const { t } = setup([rec('raid', RAIDED), rec('enemy', ENEMY)], [OWNER]);
    const a: AiStructureView[] = [];
    t.fill(a);
    const b: AiStructureView[] = [];
    t.fill(b);
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
  });

  it("hostileToPlayer: a structure by its owner's relation, anything else the NPC answer", () => {
    const { t, npcCalls } = setup([rec('enemy', ENEMY), rec('mine', OWNER)], [OWNER]);
    expect(t.hostileToPlayer('enemy', OWNER)).toBe(true);
    expect(t.hostileToPlayer('mine', OWNER)).toBe(false);
    expect(t.hostileToPlayer('enemy', 'someone')).toBe(false);
    expect(npcCalls).toEqual([]);
    expect(t.hostileToPlayer('drone-1', OWNER)).toBe(true);
    expect(npcCalls).toEqual(['drone-1']);
  });
});
