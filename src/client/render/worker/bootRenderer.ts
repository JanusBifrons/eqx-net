/**
 * Worker BOOT → `PixiRenderer` constructor arguments. Pure (no Pixi import),
 * so the boundary mapping is unit-testable outside the worker.
 *
 * The worker has no `window`, so anything the renderer would read from the
 * URL (art mode, `?cleanworld=1` and the other FX kill switches) is resolved
 * on the main thread and carried here as plain data.
 */
import type { ArtOptions } from '../art/artMode.js';
import type { FxKillSwitches } from '../fxKillSwitches.js';
import type { MainToWorkerMsg } from './protocol.js';

type BootMsg = Extract<MainToWorkerMsg, { type: 'BOOT' }>;

export function rendererArgsFromBoot(
  msg: BootMsg,
): [isTouch: boolean, art: ArtOptions, fxKillSwitches: FxKillSwitches | undefined] {
  return [
    msg.isTouch ?? false,
    {
      mode: msg.artMode ?? 'classic',
      ...(msg.artDelayMs ? { delayMs: msg.artDelayMs } : {}),
      ...(msg.fx ? { fx: true } : {}),
      ...(msg.speedFxOff ? { speedFx: false } : {}),
      ...(msg.lighting ? { lighting: msg.lighting } : {}),
    },
    msg.fxKillSwitches,
  ];
}
