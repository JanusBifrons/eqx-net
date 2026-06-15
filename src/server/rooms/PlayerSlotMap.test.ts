import { describe, it, expect } from 'vitest';
import { PlayerSlotMap } from './PlayerSlotMap.js';

describe('PlayerSlotMap', () => {
  it('initialises the free pool in reverse so slot 0 pops first', () => {
    const m = new PlayerSlotMap(4);
    expect(m.freeSlots).toEqual([3, 2, 1, 0]);
    expect(m.hasFreeSlot()).toBe(true);
    expect(m.size).toBe(0);
  });

  it('allocSlot pops the next free slot and binds both directions', () => {
    const m = new PlayerSlotMap(3);
    const s = m.allocSlot('p1');
    expect(s).toBe(0);
    expect(m.playerToSlot.get('p1')).toBe(0);
    expect(m.slotToPlayer.get(0)).toBe('p1');
    expect(m.size).toBe(1);
  });

  it('allocSlot returns null when the pool is empty', () => {
    const m = new PlayerSlotMap(1);
    expect(m.allocSlot('p1')).toBe(0);
    expect(m.allocSlot('p2')).toBeNull();
  });

  it('freeSlotForPlayer returns the slot to the pool and clears both maps', () => {
    const m = new PlayerSlotMap(3);
    const s = m.allocSlot('p1')!;
    expect(m.freeSlotForPlayer('p1')).toBe(s);
    expect(m.playerToSlot.has('p1')).toBe(false);
    expect(m.slotToPlayer.has(s)).toBe(false);
    expect(m.freeSlots).toContain(s);
  });

  it('lingering bind/release manages a separate keying space', () => {
    const m = new PlayerSlotMap(3);
    const s = m.allocSlot('p1')!;
    // simulate transfer of the slot ownership from player to lingering
    m.playerToSlot.delete('p1');
    m.slotToPlayer.delete(s);
    m.bindLinger('ship-instance-1', s);
    expect(m.lingeringSlots.get('ship-instance-1')).toBe(s);
    expect(m.releaseLinger('ship-instance-1')).toBe(s);
    expect(m.freeSlots).toContain(s);
  });

  it('assertInvariants detects a slot in multiple ownership classes', () => {
    const m = new PlayerSlotMap(2);
    const s = m.allocSlot('p1')!;
    // Cheat: leave player↔slot mapping AND bind the same slot as a lingering hull.
    m.bindLinger('ship-instance-zzz', s);
    expect(() => m.assertInvariants()).toThrow(/slot 0 claimed by both/);
  });

  it('randomised alloc/free preserves the disjoint invariant', () => {
    const m = new PlayerSlotMap(8);
    const rng = mulberry32(42);
    const owned = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const r = rng();
      if (r < 0.5 && m.hasFreeSlot()) {
        const id = `p${i}`;
        m.allocSlot(id);
        owned.add(id);
      } else if (owned.size > 0) {
        // pick an owned id and free it
        const ids = [...owned];
        const id = ids[Math.floor(rng() * ids.length)]!;
        m.freeSlotForPlayer(id);
        owned.delete(id);
      }
      m.assertInvariants();
    }
  });
});

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
