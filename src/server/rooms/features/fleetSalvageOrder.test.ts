/**
 * Fleet salvage order (slice 1): only a live wreck piece / scrap is a target;
 * ships with a mining tool take the order, the rest escort the first
 * salvager; a command with no miner is a no-op. Real `FleetCommandSubsystem`
 * over hand-rolled hooks, plus the `fleet_order` handler for the target gate.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from 'colyseus';
import { FleetCommandSubsystem, type FleetCommandHooks } from '../../fleet/FleetCommandSubsystem.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { SWARM_KIND_ASTEROID, SWARM_KIND_DRONE, SWARM_KIND_SCRAP, SWARM_KIND_STRUCTURE, SWARM_KIND_WRECK } from '../../../shared-types/swarmWireFormat.js';
import { isSalvageFleetTarget, makeFleetSalvageOrder } from './fleetSalvageOrder.js';
import { registerFleetMessages, type FleetMessageHost } from './fleetMessages.js';
import { createRelationContext } from '../../../shared-types/relations.js';

const RECS: Record<number, { id: string; kind: number; shipKind?: string }> = {
  1: { id: 'rock', kind: SWARM_KIND_ASTEROID },
  2: { id: 'drone', kind: SWARM_KIND_DRONE },
  3: { id: 'struct', kind: SWARM_KIND_STRUCTURE },
  4: { id: 'scrap', kind: SWARM_KIND_SCRAP, shipKind: 'fighter' },
  5: { id: 'wreck', kind: SWARM_KIND_WRECK, shipKind: 'cruiser' },
  6: { id: 'pod', kind: SWARM_KIND_SCRAP, shipKind: 'cargo-pod' },
};
const reg = { getByEntityId: (eid: number) => (RECS[eid] ?? null) } as unknown as FleetMessageHost['swarmRegistry'];

function fleet() {
  const owners = new Map<string, string>();
  const issued: string[] = [];
  const hooks: FleetCommandHooks = {
    ownerOf: (id) => owners.get(id) ?? null,
    readPose: () => false,
    orderIssued: (id) => issued.push(id),
  };
  const sys = new FleetCommandSubsystem(hooks, { disabled: false });
  const add = (id: string, owner = 'alice'): void => {
    owners.set(id, owner);
    sys.attach(id, owner, { kind: getShipKind('fighter') }, { x: 0, y: 0 });
  };
  return { sys, add, issued };
}

describe('fleet salvage order', () => {
  it('targets only a live wreck piece or scrap: rocks, pods, drones, structures and ships are refused', () => {
    expect(isSalvageFleetTarget('swarm-5', reg)).toBe(true);
    expect(isSalvageFleetTarget('swarm-4', reg)).toBe(true);
    expect(isSalvageFleetTarget('swarm-1', reg)).toBe(false);
    expect(isSalvageFleetTarget('swarm-6', reg)).toBe(false);
    expect(isSalvageFleetTarget('swarm-2', reg)).toBe(false);
    expect(isSalvageFleetTarget('swarm-3', reg)).toBe(false);
    expect(isSalvageFleetTarget('swarm-99', reg)).toBe(false);
    expect(isSalvageFleetTarget('hull-1', reg)).toBe(false);
  });

  it('a miner takes the order; a non-miner in the same command escorts the miner', () => {
    const { sys, add, issued } = fleet();
    add('miner'); add('gun');
    const apply = makeFleetSalvageOrder(sys, (id) => id === 'miner');
    const r = apply('alice', ['gun', 'miner'], 'swarm-5');
    expect(r.salvagers).toEqual(['miner']);
    expect(r.guards).toEqual(['gun']);
    expect(sys.ordersOf('miner')!.order).toEqual({ kind: 'salvage', targetId: 'swarm-5' });
    expect(issued).toEqual(['miner']);
    const g = sys.ordersOf('gun')!;
    expect(g.order).toBeNull();
    expect(g.mode).toBe('escort');
    expect(g.escortId).toBe('miner');
  });

  it('several miners all salvage; guards escort the first', () => {
    const { sys, add } = fleet();
    add('m1'); add('m2'); add('gun');
    const r = makeFleetSalvageOrder(sys, (id) => id !== 'gun')('alice', ['m1', 'gun', 'm2'], 'swarm-4');
    expect(r.salvagers).toEqual(['m1', 'm2']);
    expect(sys.ordersOf('gun')!.escortId).toBe('m1');
  });

  it('no miner in the command: nothing happens', () => {
    const { sys, add, issued } = fleet();
    add('gun');
    const r = makeFleetSalvageOrder(sys, () => false)('alice', ['gun'], 'swarm-5');
    expect(r.salvagers).toEqual([]);
    expect(r.guards).toEqual([]);
    expect(issued).toEqual([]);
    expect(sys.ordersOf('gun')!.mode).toBe('defend');
  });

  it('a foreign miner is not accepted, so the guards stay put', () => {
    const { sys, add } = fleet();
    add('theirs', 'bob'); add('gun');
    const r = makeFleetSalvageOrder(sys, (id) => id === 'theirs')('alice', ['theirs', 'gun'], 'swarm-5');
    expect(r.salvagers).toEqual([]);
    expect(sys.ordersOf('theirs')!.order).toBeNull();
    expect(sys.ordersOf('gun')!.mode).toBe('defend');
  });

  it('the fleet_order handler drops a salvage order on a rock, pod or ship', () => {
    const { sys, add } = fleet();
    add('miner');
    const handlers = new Map<string, (client: Client, raw: unknown) => void>();
    const h = {
      onMessage: (type: string, fn: (client: Client, raw: unknown) => void) => { handlers.set(type, fn); },
      malformed: { record: () => {} },
      sessionToPlayer: () => new Map([['sess-1', 'alice']]),
      fleetMsgAllowed: () => true,
      fleet: sys,
      fleetCanSalvage: (id: string) => id === 'miner',
      fleetTransit: () => null,
      fleetStatusSoon: { request: () => {} },
      serverTick: () => 0,
      playerToActiveShipInstance: new Map(),
      swarmRegistry: reg,
      structureRegistry: { get: () => undefined },
      relationCtx: createRelationContext(),
    } as unknown as FleetMessageHost;
    registerFleetMessages(h);
    const send = (targetId: string) =>
      handlers.get('fleet_order')!({ sessionId: 'sess-1' } as Client, { type: 'fleet_order', kind: 'salvage', shipIds: ['miner'], targetId });
    for (const t of ['swarm-1', 'swarm-6', 'hull-x', 'swarm-2']) {
      send(t);
      expect(sys.ordersOf('miner')!.order, t).toBeNull();
    }
    send('swarm-5');
    expect(sys.ordersOf('miner')!.order).toEqual({ kind: 'salvage', targetId: 'swarm-5' });
  });
});
