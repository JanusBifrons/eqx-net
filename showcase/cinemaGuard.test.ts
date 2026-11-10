import { describe, it, expect } from 'vitest';
import type { Page } from '@playwright/test';
import { assertCinemaAllowed, playCameraScript } from './recorder';
import type { CameraCue } from '../src/core/contracts/cameraScript';

/**
 * The camera rule (user, 2026-11-10): "It should look and feel as it would for
 * me. If you need a shot which is cinematic and panning, use spectator mode."
 * While the take's pilot flies a ship the camera is the game's follow camera;
 * a camera script plays only in spectator mode.
 */

/** A page whose store reports `pilotMode`; records the scripts it was asked to play. */
function fakePage(pilotMode: string | null): { page: Pick<Page, 'evaluate'>; played: unknown[] } {
  const played: unknown[] = [];
  const evaluate = (async (_fn: unknown, arg?: unknown) => {
    if (arg === undefined) return pilotMode; // readPilotMode
    played.push(arg); // __eqxCinema.play(cues)
    return undefined;
  }) as unknown as Page['evaluate'];
  return { page: { evaluate }, played };
}

const CUES: CameraCue[] = [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 0, zoom: 1 } }];

describe('ctx.cinema.play refuses unless the pilot is spectating', () => {
  it('throws while piloting, naming ctx.spectate()', () => {
    expect(() => assertCinemaAllowed('pilot')).toThrow(/ctx\.spectate\(\)/);
  });

  it('throws when the mode is unknown (no store)', () => {
    expect(() => assertCinemaAllowed(null)).toThrow(/refused/);
    expect(() => assertCinemaAllowed(undefined)).toThrow(/refused/);
  });

  it('allows a script in spectator mode', () => {
    expect(() => assertCinemaAllowed('spectator')).not.toThrow();
  });

  it('a piloting take never reaches the CameraDirector', async () => {
    const { page, played } = fakePage('pilot');
    await expect(playCameraScript(page, CUES)).rejects.toThrow(/follow camera/);
    expect(played).toEqual([]);
  });

  it('a spectating take plays the script', async () => {
    const { page, played } = fakePage('spectator');
    await playCameraScript(page, CUES);
    expect(played).toEqual([CUES]);
  });
});
