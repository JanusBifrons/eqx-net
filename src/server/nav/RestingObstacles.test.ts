import { describe, it, expect } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { RestingObstacles, RESTING_MIN_RADIUS, RESTING_POSE_QUANTUM } from './RestingObstacles.js';
import { FLAG_SLEEPING, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';

const SQUARE = [{ x: -60, y: -60 }, { x: 60, y: -60 }, { x: 60, y: 60 }, { x: -60, y: 60 }];

function rig() {
  const buf = new ArrayBuffer((slotBase(16) + 64) * 4), f32 = new Float32Array(buf), u32 = new Uint32Array(buf);
  const recs = new Map<string, SwarmEntityRecord>(), bus = new Bus(), sent: Array<[number, GridObstacle | null]> = [];
  let ids = 1;
  const add = (id: string, slot: number, r: Partial<SwarmEntityRecord>, x = 0, y = 0, asleep = false): void => {
    recs.set(id, { id, slot, entityId: slot, radius: 80, ...r } as SwarmEntityRecord);
    const b = slotBase(slot);
    f32[b + SLOT_X_OFF] = x; f32[b + SLOT_Y_OFF] = y; f32[b + SLOT_ANGLE_OFF] = 0;
    u32[b + SLOT_FLAGS_OFF] = asleep ? FLAG_SLEEPING : 0;
  };
  const move = (slot: number, x: number, y: number): void => { f32[slotBase(slot) + SLOT_X_OFF] = x; f32[slotBase(slot) + SLOT_Y_OFF] = y; };
  const nav = new RestingObstacles(
    { swarm: { get: (id) => recs.get(id) ?? null, all: () => recs.values() }, sabF32: () => f32, sabU32: () => u32, bus },
    (id, o) => sent.push([id, o]), () => ids++);
  return { add, move, nav, bus, sent };
}

describe('resting wrecks, scrap and asteroids as fine nav obstacles (nav fine rebuild slice C2)', () => {
  it('sends the bodies already asleep at start, and later rests; only wrecks, scrap and plain rocks of size', () => {
    const { add, nav, bus, sent } = rig();
    add('wreck', 1, { kind: 4, wreckParts: [SQUARE] }, 1000, 2000, true);
    add('awake', 2, { kind: 4, wreckParts: [SQUARE] }, 0, 0, false);
    add('scrap', 3, { kind: 3, vertices: SQUARE }, 0, 0, false);
    add('pod', 4, { kind: 3, shipKind: 'cargo-pod' }, 0, 0, true);
    add('fieldRock', 5, { kind: 0, fieldRock: true, vertices: SQUARE }, 0, 0, true);
    add('base', 6, { kind: 2 }, 0, 0, true);    // structures come through the registry (C1)
    add('drone', 7, { kind: 1 }, 0, 0, true);
    add('tiny', 8, { kind: 3, radius: RESTING_MIN_RADIUS - 1 }, 0, 0, true);
    nav.attach();
    expect(sent.map(([, o]) => o && [o.x, o.y])).toEqual([[1000, 2000]]);
    expect(sent[0]![1]!.radius).toBeCloseTo(Math.hypot(60, 60), 6) // the circle encloses the parts;
    expect(sent[0]![1]!.parts).toEqual([SQUARE]);
    for (const id of ['pod', 'fieldRock', 'base', 'drone', 'tiny', 'player-1']) bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: id });
    expect(sent.length).toBe(1);
    bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: 'scrap' });
    expect(sent.length).toBe(2);
    expect(sent[1]![1]!.parts).toBeDefined();
  });

  it('a nudge that re-rests within the quantum sends nothing; a real move re-sends under the same id', () => {
    const { add, move, nav, bus, sent } = rig();
    add('w', 1, { kind: 4, wreckParts: [SQUARE] }, 0, 0, true);
    nav.attach();
    bus.emit('ENTITY_WOKE', { type: 'ENTITY_WOKE', entityId: 'w' }); // a wake keeps the obstacle
    move(1, RESTING_POSE_QUANTUM - 1, 0);
    bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: 'w' });
    expect(sent.length).toBe(1);
    move(1, 500, 0);
    bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: 'w' });
    expect(sent.length).toBe(2);
    expect(sent[1]![0]).toBe(sent[0]![0]);
    expect(sent[1]![1]!.x).toBe(500);
  });

  it('eviction removes the obstacle once; detach stops listening', () => {
    const { add, nav, bus, sent } = rig();
    add('w', 1, { kind: 4, wreckParts: [SQUARE] }, 0, 0, true);
    nav.attach();
    nav.gone('w'); nav.gone('w'); nav.gone('never-sent');
    expect(sent).toEqual([[sent[0]![0], sent[0]![1]], [sent[0]![0], null]]);
    nav.detach();
    bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: 'w' });
    expect(sent.length).toBe(2);
  });
});
