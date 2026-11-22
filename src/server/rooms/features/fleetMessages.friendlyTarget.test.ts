/**
 * S3b — a `fleet_order` attack on the caller's own (or an allied) structure or
 * ship is dropped server-side; a hostile / neutral target is accepted.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'colyseus';
import { isFriendlyFleetTarget, registerFleetMessages, wireSwarmEntityId, type FleetMessageHost } from './fleetMessages.js';
import { createRelationContext } from '../../../shared-types/relations.js';

const STRUCT_OWNER: Record<string, string> = { 'st-own': 'p1', 'st-ally': 'p2', 'st-foe': 'p3' };
const ENTITY: Record<number, string> = { 7: 'st-own', 8: 'st-ally', 9: 'st-foe', 10: 'drone-a' };

function host(applyOrder = vi.fn(() => [] as string[])) {
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const h = {
    onMessage: (type: string, fn: (client: Client, raw: unknown) => void) => { handlers.set(type, fn); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['sess-1', 'p1']]),
    fleetMsgAllowed: () => true,
    fleet: { applyOrder, ownerOfAttached: (id: string) => (id === 'hull-mine' ? 'p1' : id === 'hull-foe' ? 'p3' : null) },
    fleetTransit: () => null,
    fleetStatusSoon: { request: () => {} },
    serverTick: () => 0,
    playerToActiveShipInstance: new Map(),
    swarmRegistry: { getByEntityId: (eid: number) => (ENTITY[eid] !== undefined ? { id: ENTITY[eid] } : null) },
    structureRegistry: { get: (id: string) => (STRUCT_OWNER[id] !== undefined ? { owner: STRUCT_OWNER[id] } : undefined) },
    relationCtx: createRelationContext({ alliances: { areAllied: (a: string, b: string) => [a, b].sort().join() === 'p1,p2' } }),
  } as unknown as FleetMessageHost;
  registerFleetMessages(h);
  const attack = (targetId: string) =>
    handlers.get('fleet_order')!({ sessionId: 'sess-1' } as Client, { type: 'fleet_order', kind: 'attack', shipIds: ['hull-mine'], targetId });
  return { h, applyOrder, attack };
}

describe('fleet_order attack: friendly targets are refused', () => {
  it('parses wire swarm ids', () => {
    expect(wireSwarmEntityId('swarm-42')).toBe(42);
    expect(wireSwarmEntityId('swarm-')).toBe(-1);
    expect(wireSwarmEntityId('swarm-4x')).toBe(-1);
    expect(wireSwarmEntityId('p3')).toBe(-1);
  });

  it('own and allied structures / own ships are friendly; hostile, neutral and drones are not', () => {
    const { h } = host();
    expect(isFriendlyFleetTarget('p1', 'swarm-7', h)).toBe(true); // my structure
    expect(isFriendlyFleetTarget('p1', 'swarm-8', h)).toBe(true); // ally's structure
    expect(isFriendlyFleetTarget('p1', 'swarm-9', h)).toBe(false); // someone else's
    expect(isFriendlyFleetTarget('p1', 'swarm-10', h)).toBe(false); // a drone (no structure owner)
    expect(isFriendlyFleetTarget('p1', 'hull-mine', h)).toBe(true); // my parked hull
    expect(isFriendlyFleetTarget('p1', 'p1', h)).toBe(true); // the ship I fly
    expect(isFriendlyFleetTarget('p1', 'hull-foe', h)).toBe(false);
    expect(isFriendlyFleetTarget('p1', 'p3', h)).toBe(false);
  });

  it('drops the order on my own structure and passes a hostile one to the fleet', () => {
    const { applyOrder, attack } = host();
    attack('swarm-7');
    expect(applyOrder).not.toHaveBeenCalled();
    attack('swarm-9');
    expect(applyOrder).toHaveBeenCalledWith('p1', ['hull-mine'], { kind: 'attack', targetId: 'swarm-9' });
  });
});
