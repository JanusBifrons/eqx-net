/**
 * Replay-time Keyboard substitute. Production `Keyboard` registers
 * window listeners; here we just hand back whatever state the harness
 * last set. The harness calls `setState()` before each inner-tick of
 * `tickPhysics()` to replay the captured `input_intent` stream.
 *
 * Same shape as the production `Keyboard.read()` return value so a
 * `ColyseusGameClient` passed this in lieu of the real keyboard cannot
 * tell the difference.
 */
export interface KeyboardReadResult {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  fireHeld: boolean;
  boost: boolean;
  reverse: boolean;
  /** Production `Keyboard` clears its one-shot `fire` on read. Production
   *  `tickPhysics` uses `fireHeld` for hitscan beam + cooldown gating; the
   *  one-shot `fire` field is read separately. For replay we expose both,
   *  with `fire` defaulting to false (replays use the held semantics). */
  fire?: boolean;
}

const DEFAULT_STATE: KeyboardReadResult = {
  thrust: false,
  turnLeft: false,
  turnRight: false,
  fireHeld: false,
  boost: false,
  reverse: false,
  fire: false,
};

export class MockKeyboard {
  private state: KeyboardReadResult = { ...DEFAULT_STATE };

  read(): KeyboardReadResult {
    return { ...this.state };
  }

  setState(next: Partial<KeyboardReadResult>): void {
    this.state = { ...this.state, ...next };
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
  }
}
