export interface IAudio {
  playLaserFire(x: number, y: number): void;
  playExplosion(x: number, y: number): void;
  setClockRate(rate: number): void;
  dispose(): void;
}
