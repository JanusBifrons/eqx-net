/**
 * Replay-time substitute for the `colyseus.js` `Room`. Just enough
 * surface to be assigned to `ColyseusGameClient.room` and let the
 * production code's `room.send('input', payload)` / `room.send('fire', ...)`
 * paths execute. Every send is captured for assertion.
 *
 * The harness DOES NOT use `room.onMessage(...)` registration — it
 * bypasses `connect()` entirely and calls `internals.handleSnapshot(...)`
 * directly (matching the pattern in `ColyseusClient.lingeringJitter.test.ts`).
 * This mock therefore only needs `send`, `leave`, and the state/identity
 * surface ColyseusGameClient touches.
 */

export interface SentMessage {
  type: string;
  payload: unknown;
  atMs: number;
}

export class MockRoom {
  readonly roomId: string = 'replay-room';
  readonly sessionId: string = 'replay-session';
  state: Record<string, unknown> = {};

  /** Captured `room.send(type, payload)` calls. The harness reads this
   *  to verify the input-flow contract (e.g. no >N RAF window with zero
   *  inputSent events while a key is held). */
  readonly sent: SentMessage[] = [];

  /** Clock reference — set by the harness so `send()` timestamps the
   *  call with the harness's MockClock, not real time. */
  getTimeMs: () => number = () => 0;

  send(type: string, payload?: unknown): void {
    this.sent.push({ type, payload, atMs: this.getTimeMs() });
  }

  // The following are no-ops; production calls them but for replay we
  // don't need their effects. Onmessage/onstate handlers are never wired
  // because the harness bypasses `connect()`.
  onMessage(_type: string, _handler: (msg: unknown) => void): void {
    /* no-op for replay */
  }

  onStateChange(_handler: (state: unknown) => void): void {
    /* no-op for replay */
  }

  onLeave(_handler: (code: number) => void): void {
    /* no-op for replay */
  }

  onError(_handler: (code: number, message?: string) => void): void {
    /* no-op for replay */
  }

  async leave(_consented?: boolean): Promise<void> {
    /* no-op for replay */
  }

  removeAllListeners(): void {
    /* no-op for replay */
  }
}
