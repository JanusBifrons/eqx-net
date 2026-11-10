import { describe, it, expect } from 'vitest';
import { rendererArgsFromBoot } from './bootRenderer';
import type { MainToWorkerMsg } from './protocol';
import type { FxKillSwitches } from '../fxKillSwitches';

type BootMsg = Extract<MainToWorkerMsg, { type: 'BOOT' }>;

const SWITCHES: FxKillSwitches = {
  filtersDisabled: true,
  particlesDisabled: true,
  beamsDisabled: false,
  dmgNumbersDisabled: false,
  healthBarsDisabled: false,
  selfDmgNumbersDisabled: true,
  cleanWorld: true,
};

function boot(extra: Partial<BootMsg> = {}): BootMsg {
  return { type: 'BOOT', canvas: {} as unknown as OffscreenCanvas, width: 800, height: 600, dpr: 1, ...extra };
}

describe('rendererArgsFromBoot (worker BOOT → PixiRenderer)', () => {
  it('hands the main thread kill switches to the renderer (the worker has no window to read ?cleanworld=1 from)', () => {
    const [, , fx] = rendererArgsFromBoot(boot({ fxKillSwitches: SWITCHES }));
    expect(fx).toEqual(SWITCHES);
  });

  it('leaves the switches unset when BOOT carries none', () => {
    const [, , fx] = rendererArgsFromBoot(boot());
    expect(fx).toBeUndefined();
  });

  it('maps touch + art options as before', () => {
    const [isTouch, art] = rendererArgsFromBoot(
      boot({ isTouch: true, artMode: 'machined', fx: true, speedFxOff: true, artDelayMs: 5 }),
    );
    expect(isTouch).toBe(true);
    expect(art).toEqual({ mode: 'machined', delayMs: 5, fx: true, speedFx: false });
  });
});
