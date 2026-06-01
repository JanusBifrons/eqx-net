export interface IAudio {
  playLaserFire(x: number, y: number): void;
  playExplosion(x: number, y: number): void;
  setClockRate(rate: number): void;
  /**
   * Plan: crispy-kazoo, Commit 4 — pause boundary.
   * Suspend the underlying audio context (no playback until resumed).
   * The implementation returns a promise so callers can await the
   * suspended state; in practice the resolution is fire-and-forget.
   */
  suspendAll(): Promise<void>;
  resumeAll(): Promise<void>;
  dispose(): void;
}
