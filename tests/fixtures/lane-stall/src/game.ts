// Fixture source for tests/unit/lane-stall-names.test.ts: built once with
// esbuild (minified, external source map) into ../lane-dist/assets/index-Fx1.js.
let swarm: number[] = [];

export function stepSwarm(dt: number): number {
  let sum = 0;
  for (const s of swarm) sum += s * dt;
  return sum;
}

export function renderFrame(now: number): void {
  const total = stepSwarm(now / 1000);
  if (total > 1e9) swarm = [];
  requestAnimationFrame(renderFrame);
}

export const onResize = (w: number, h: number): number => w * h + stepSwarm(1);
