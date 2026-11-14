import type { AiInputBits } from '../contracts/IAiBehaviour.js';

/**
 * Pilot layer: one tick's AI control keys, batched into a reusable
 * `AI_INPUTS` worker command (one `postMessage` a tick instead of one per
 * drone). `push` appends a slot's packed {@link AiInputBits}; the owner posts
 * {@link cmd} when {@link count} > 0, then calls {@link clear}.
 *
 * Alloc-free in steady state (#14): the typed arrays grow by doubling only
 * when a tick holds more AI pilots than ever before, and the command object is
 * reused (`postMessage` clones it synchronously, so mutating it next tick is
 * safe). The arrays are sized to the high-water mark, not `MAX_ENTITIES`,
 * because structured clone copies a typed array's WHOLE buffer.
 */
export class AiInputBatch {
  /** The `AI_INPUTS` command; `slots[i]` / `bits[i]` valid for i < `count`. */
  readonly cmd: { type: 'AI_INPUTS'; count: number; slots: Uint16Array; bits: Uint8Array };

  constructor(initialCapacity = 64) {
    const cap = Math.max(1, initialCapacity | 0);
    this.cmd = { type: 'AI_INPUTS', count: 0, slots: new Uint16Array(cap), bits: new Uint8Array(cap) };
  }

  get count(): number {
    return this.cmd.count;
  }

  push(slot: number, bits: AiInputBits): void {
    const c = this.cmd;
    if (c.count >= c.slots.length) {
      const cap = c.slots.length * 2;
      const slots = new Uint16Array(cap); // high-water growth only, not per tick
      slots.set(c.slots);
      const b = new Uint8Array(cap);
      b.set(c.bits);
      c.slots = slots;
      c.bits = b;
    }
    c.slots[c.count] = slot;
    c.bits[c.count] = bits;
    c.count++;
  }

  clear(): void {
    this.cmd.count = 0;
  }
}
