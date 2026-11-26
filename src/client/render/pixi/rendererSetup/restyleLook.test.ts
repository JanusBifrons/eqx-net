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
import { BuildSlotOutlines } from '../buildSlotOutlines.js';
import type { StructureDeckPlates } from '../structureDeckPlates.js';
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
    ...(art.deckTex !== undefined ? { deckTex: art.deckTex } : {}),
    ...(art.fenceLook !== undefined ? { fenceLook: art.fenceLook } : {}),
    ...(art.zones !== undefined ? { zones: art.zones } : {}),
    ...(art.approach !== undefined ? { approach: art.approach } : {}),
    ...(art.buildSlots !== undefined ? { buildSlots: art.buildSlots } : {}),
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

  it('?deckTex= rides BOOT to the worker (plain = the flat floor)', () => {
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?deckTex=plain') };
    const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
    expect(resolveRestyleLook(workerArt, null).deckTex).toBe('plain');
    expect(resolveRestyleLook({ mode: 'machined', ...readRestyleLook('?deckTex=b') }, null).deckTex).toBe('b');
  });

  it('a worker renderer booted without the fields falls back to the defaults (on)', () => {
    expect(resolveRestyleLook({ mode: 'classic' }, null)).toEqual({ lineLook: 'cable', rigs: true, deckTex: 'a', fenceLook: 'new', zones: true, approach: true, buildSlots: true });
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

  it('socket nubs (0d slice 10) ride the same flag', () => {
    const ctx: { socketNubs?: boolean } = {};
    applyRestyleLook({ lineLook: null }, ctx, new Container(), { mode: 'machined', fx: true }, '');
    expect(ctx.socketNubs).toBe(true);
    applyRestyleLook({ lineLook: null }, ctx, new Container(), { mode: 'machined' }, '');
    expect(ctx.socketNubs).toBe(false);
  });
});

describe('deck fence beam look (base platforms slice 30, `?fenceLook=`)', () => {
  it('defaults to old; new rides BOOT to the worker and turns the cache flag on', () => {
    expect(readRestyleLook('').fenceLook).toBe('new');
    expect(readRestyleLook('?fenceLook=bogus').fenceLook).toBe('new');
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=sector&fenceLook=new') };
    const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
    const conn = { lineLook: null, cables: { fenceBeams: false } };
    applyRestyleLook(conn, {}, new Container(), workerArt, null);
    expect(conn.cables.fenceBeams).toBe(true);
    applyRestyleLook(conn, {}, new Container(), { mode: 'machined' }, '?fenceLook=old');
    expect(conn.cables.fenceBeams).toBe(false);
    applyRestyleLook(conn, {}, new Container(), { mode: 'machined' }, '?fenceLook=new');
    expect(conn.cables.fenceBeams).toBe(true);
  });
});

describe('deck zone markings (base platforms slice 33, `?zones=`)', () => {
  it('defaults to on; off rides BOOT to the worker and builds the floor without zone paint', () => {
    expect(readRestyleLook('').zones).toBe(true);
    expect(readRestyleLook('?zones=on').zones).toBe(true);
    expect(readRestyleLook('?zones=bogus').zones).toBe(true);
    expect(readRestyleLook('?room=sector&zones=off').zones).toBe(false);
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=sector&zones=off') };
    const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
    expect(workerArt.zones).toBe(false);
    const off: { deckPlates?: StructureDeckPlates } = {};
    applyRestyleLook({ lineLook: null }, off, new Container(), workerArt, null);
    expect(off.deckPlates!.zones).toBeUndefined();
    const on: { deckPlates?: StructureDeckPlates } = {};
    applyRestyleLook({ lineLook: null }, on, new Container(), { mode: 'machined' }, '?zones=on');
    expect(on.deckPlates!.zones).toBeDefined();
  });
});

describe('gate approach lights (`?approach=`)', () => {
  it('defaults to on; the choice rides BOOT to the worker and builds the lights', () => {
    expect(readRestyleLook('').approach).toBe(true);
    expect(readRestyleLook('?approach=bogus').approach).toBe(true);
    expect(readRestyleLook('?room=deck-bases&approach=off').approach).toBe(false);
    expect(readRestyleLook('?room=deck-bases&approach=on').approach).toBe(true);
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=deck-bases&approach=off') };
    const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
    expect(workerArt.approach).toBe(false);
    const off: { deckPlates?: StructureDeckPlates } = {};
    applyRestyleLook({ lineLook: null }, off, new Container(), workerArt, null);
    expect(off.deckPlates!.approach).toBeUndefined();
    const on: { deckPlates?: StructureDeckPlates } = {};
    applyRestyleLook({ lineLook: null }, on, new Container(), { mode: 'machined' }, '');
    expect(on.deckPlates!.approach).toBeDefined();
  });
});

describe('build-slot outlines (`?buildSlots=`)', () => {
  it('defaults to on (builds the outlines on the ghost ctx); `off` rides BOOT to the worker', () => {
    expect(readRestyleLook('').buildSlots).toBe(true);
    expect(resolveRestyleLook({ mode: 'classic' }, null).buildSlots).toBe(true);
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=deck') };
    const [, workerArt] = rendererArgsFromBoot(structuredClone(bootFrom(art)));
    expect(workerArt.buildSlots).toBe(true);
    const ghost: { slotOutlines: BuildSlotOutlines | null } = { slotOutlines: null };
    applyRestyleLook({ lineLook: null }, {}, new Container(), workerArt, null, ghost);
    expect(ghost.slotOutlines).toBeInstanceOf(BuildSlotOutlines);
    const offArt: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=deck&buildSlots=off') };
    const [, offWorker] = rendererArgsFromBoot(structuredClone(bootFrom(offArt)));
    expect(offWorker.buildSlots).toBe(false);
    const off: { slotOutlines: BuildSlotOutlines | null } = { slotOutlines: null };
    applyRestyleLook({ lineLook: null }, {}, new Container(), offWorker, null, off);
    expect(off.slotOutlines).toBeNull();
  });
});
