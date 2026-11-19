/**
 * Structure restyle on BOTH renderer paths: the desktop worker renderer has no
 * `window`, so the line look + rig flag ride BOOT (main thread parses the URL)
 * and the worker-side init step builds the same `StructureRigs` + line look
 * the main-thread renderer does. `?rigs=0` / `?lineLook=off` turn them off on
 * both paths.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { applyRestyleLook, readRestyleLook, resolveRestyleLook } from './restyleLook.js';
import { StructureRigs } from '../structureRigs.js';
import { rendererArgsFromBoot } from '../../worker/bootRenderer.js';
import type { MainToWorkerMsg } from '../../worker/protocol.js';
import type { ArtOptions } from '../../art/artMode.js';
import type { LineLook } from '../connectorLineLooks.js';

type BootMsg = Extract<MainToWorkerMsg, { type: 'BOOT' }>;

/** The main thread's art options → BOOT fields, as `WorkerRendererClient.init` posts them. */
function bootFrom(art: ArtOptions): BootMsg {
  return {
    type: 'BOOT', canvas: {} as unknown as OffscreenCanvas, width: 800, height: 600, dpr: 1, artMode: art.mode,
    ...(art.lineLook !== undefined ? { lineLook: art.lineLook } : {}),
    ...(art.rigs !== undefined ? { rigs: art.rigs } : {}),
  };
}

function scene(): { conn: { lineLook: LineLook | null }; ctx: { structureRigs?: StructureRigs }; ships: Container } {
  return { conn: { lineLook: null }, ctx: {}, ships: new Container() };
}

/** Desktop (worker) path end to end: URL → ArtOptions → BOOT → worker art → init step (no URL). */
function workerScene(search: string): ReturnType<typeof scene> {
  const art: ArtOptions = { mode: 'machined', ...readRestyleLook(search) };
  const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
  const s = scene();
  applyRestyleLook(s.conn, s.ctx, s.ships, workerArt, null);
  return s;
}

describe('structure restyle on the worker renderer', () => {
  it('BOOT carries lineLook + rigs and the worker art options keep them (null = off survives the clone)', () => {
    expect(rendererArgsFromBoot(bootFrom({ mode: 'machined', lineLook: 'cable', rigs: true }))[1])
      .toMatchObject({ lineLook: 'cable', rigs: true });
    const off = rendererArgsFromBoot(structuredClone(bootFrom({ mode: 'machined', lineLook: null, rigs: false })))[1];
    expect(off.lineLook).toBeNull();
    expect(off.rigs).toBe(false);
  });

  it('by default the worker-side scene builds StructureRigs and the cable line look', () => {
    const s = workerScene('?room=rig-home');
    expect(s.ctx.structureRigs).toBeInstanceOf(StructureRigs);
    expect(s.conn.lineLook).toBe('cable');
  });

  it('?rigs=0 / ?lineLook=off turn them off on the worker path', () => {
    expect(workerScene('?rigs=0').ctx.structureRigs).toBeUndefined();
    expect(workerScene('?lineLook=off').conn.lineLook).toBeNull();
    expect(workerScene('?lineLook=pipe').conn.lineLook).toBe('pipe');
  });

  it('a worker renderer booted without the fields falls back to the defaults (on)', () => {
    expect(resolveRestyleLook({ mode: 'classic' }, null)).toEqual({ lineLook: 'cable', rigs: true });
  });
});

describe('structure restyle on the main-thread renderer', () => {
  it('reads the URL when the art options carry nothing', () => {
    const s = scene();
    applyRestyleLook(s.conn, s.ctx, s.ships, { mode: 'machined' }, '?rigs=0&lineLook=off');
    expect(s.ctx.structureRigs).toBeUndefined();
    expect(s.conn.lineLook).toBeNull();
    const on = scene();
    applyRestyleLook(on.conn, on.ctx, on.ships, { mode: 'machined' }, '');
    expect(on.ctx.structureRigs).toBeInstanceOf(StructureRigs);
    expect(on.conn.lineLook).toBe('cable');
  });

  it('the resolved art options win over the URL (one source of truth)', () => {
    const s = scene();
    applyRestyleLook(s.conn, s.ctx, s.ships, { mode: 'machined', ...readRestyleLook('?rigs=0&lineLook=off') }, '');
    expect(s.ctx.structureRigs).toBeUndefined();
    expect(s.conn.lineLook).toBeNull();
  });
});

describe('socket cables follow the new-effects flag (0d slice 8)', () => {
  it('on with art.fx (both paths, via BOOT on the worker), off without it', () => {
    const conn: { lineLook: LineLook | null; socketCables?: boolean } = { lineLook: null };
    applyRestyleLook(conn, {}, new Container(), { mode: 'machined', fx: true }, '');
    expect(conn.socketCables).toBe(true);
    applyRestyleLook(conn, {}, new Container(), { mode: 'machined' }, '');
    expect(conn.socketCables).toBe(false);
    const [, workerArt] = rendererArgsFromBoot(structuredClone({ ...bootFrom({ mode: 'machined' }), fx: true }));
    applyRestyleLook(conn, {}, new Container(), workerArt, null);
    expect(conn.socketCables).toBe(true);
  });
});
