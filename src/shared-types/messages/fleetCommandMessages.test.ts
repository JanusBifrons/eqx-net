/** `fleet_order` wire schema: the salvage order (fleet salvage slice 1). */
import { describe, it, expect } from 'vitest';
import { FleetOrderSchema } from './fleetCommandMessages.js';

const base = { type: 'fleet_order', shipIds: ['hull-1'] } as const;

describe('FleetOrderSchema salvage', () => {
  it('accepts a salvage order with a target id', () => {
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'salvage', targetId: 'swarm-12' }).success).toBe(true);
  });

  it('rejects a salvage order without, with an empty or with an over-long target id', () => {
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'salvage' }).success).toBe(false);
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'salvage', targetId: '' }).success).toBe(false);
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'salvage', targetId: 'x'.repeat(65) }).success).toBe(false);
  });

  it('stays strict: an unknown key is rejected', () => {
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'salvage', targetId: 'swarm-1', extra: 1 }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(FleetOrderSchema.safeParse({ ...base, kind: 'mine', targetId: 'swarm-1' }).success).toBe(false);
  });
});
