/**
 * Pilot layer (AI flies with player controls), slice 1a: an intent carrying
 * `input` bits goes to the sink's batch, NOT the impulse path, and the whole
 * tick's inputs leave as ONE flush (one worker message), however many ships.
 */
import { describe, expect, it } from 'vitest';
import { AiController, type AiIntentSink } from './AiController.js';
import { AiInputBatch } from './AiInputBatch.js';
import {
  AI_INPUT_BOOST,
  AI_INPUT_THRUST,
  AI_INPUT_TURN_LEFT,
  decodeAiInputBits,
  packAiInputBits,
  type AiEntity,
  type AiIntent,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';

class FixedBehaviour implements IAiBehaviour {
  constructor(private readonly intent: AiIntent) {}
  tick(): AiIntent {
    return this.intent;
  }
}

class BatchingSink implements AiIntentSink {
  readonly batch = new AiInputBatch(2);
  impulses = 0;
  posts: Array<{ count: number; slots: number[]; bits: number[] }> = [];
  postIntent(): void {
    this.impulses++;
  }
  postInput(slot: number, bits: number): void {
    this.batch.push(slot, bits);
  }
  flushInputs(): void {
    const c = this.batch.cmd;
    this.posts.push({ count: c.count, slots: Array.from(c.slots.subarray(0, c.count)), bits: Array.from(c.bits.subarray(0, c.count)) });
    this.batch.clear();
  }
}

const pose = (id: string): AiEntity => ({ id, x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });

describe('AiController input-bit intents', () => {
  it('batches every input intent of a tick into ONE flush, and skips the impulse path', () => {
    const sink = new BatchingSink();
    const ctrl = new AiController(sink);
    const n = 5; // more than the batch's initial capacity of 2: it grows
    for (let i = 0; i < n; i++) {
      ctrl.register(`d${i}`, 10 + i, new FixedBehaviour({ fx: 9, fy: 9, torque: 9, input: AI_INPUT_THRUST | (i % 2 ? AI_INPUT_TURN_LEFT : 0) }));
    }
    ctrl.tick(0, 1 / 60, [], pose);
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]!.count).toBe(n);
    expect(sink.posts[0]!.slots).toEqual([10, 11, 12, 13, 14]);
    expect(sink.posts[0]!.bits).toEqual([1, 5, 1, 5, 1]);
    expect(sink.impulses).toBe(0); // input REPLACES fx/fy/torque

    ctrl.tick(1, 1 / 60, [], pose);
    expect(sink.posts).toHaveLength(2); // one post per tick
  });

  it('input 0 (no keys) is still an input intent; impulse intents keep AI_INTENT', () => {
    const sink = new BatchingSink();
    const ctrl = new AiController(sink);
    ctrl.register('coast', 1, new FixedBehaviour({ fx: 0, fy: 0, torque: 0, input: 0 }));
    ctrl.register('rock', 2, new FixedBehaviour({ fx: 1, fy: 0, torque: 0 }));
    ctrl.tick(0, 1 / 60, [], pose);
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]!.slots).toEqual([1]);
    expect(sink.impulses).toBe(1);
  });

  it('no flush when no ship flew by input this tick', () => {
    const sink = new BatchingSink();
    const ctrl = new AiController(sink);
    ctrl.register('rock', 2, new FixedBehaviour({ fx: 1, fy: 0, torque: 0 }));
    ctrl.tick(0, 1 / 60, [], pose);
    expect(sink.posts).toHaveLength(0);
  });

  it('packs and decodes the five keys', () => {
    const out = { thrust: false, reverse: false, turnLeft: false, turnRight: false, boost: false };
    const bits = packAiInputBits(true, false, false, true, true);
    expect(bits & AI_INPUT_BOOST).toBe(AI_INPUT_BOOST);
    decodeAiInputBits(bits, out);
    expect(out).toEqual({ thrust: true, reverse: false, turnLeft: false, turnRight: true, boost: true });
  });
});
