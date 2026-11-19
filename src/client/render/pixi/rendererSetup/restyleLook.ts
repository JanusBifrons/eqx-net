/**
 * Structure restyle scene options, for BOTH renderer paths: the 1g grid line
 * look (`?lineLook=off|pipe|conduit`, cable by default) and the 2c rig parts
 * (`?rigs=0` off). Read from the URL on the main thread (`selectRenderer`) and
 * carried on `ArtOptions` — the render worker has no `window`, so it gets them
 * on BOOT like the structure style. Absent on `ArtOptions` (a renderer built
 * without them, e.g. a test) ⇒ the URL on the main thread, the defaults in a
 * worker.
 */
import type { Container } from 'pixi.js';
import type { ArtOptions } from '../../art/artMode.js';
import { DEFAULT_LINE_LOOK, readLineLook, type LineLook } from '../connectorLineLooks.js';
import { readRigsFlag, StructureRigs } from '../structureRigs.js';

export interface RestyleLook {
  /** Grid line look; null = the pre-restyle thin line. */
  lineLook: LineLook | null;
  /** Draw structure rig parts (pad, crane, hatches). */
  rigs: boolean;
}

/** The restyle scene options from a URL query string. */
export function readRestyleLook(search: string): RestyleLook {
  return { lineLook: readLineLook(search), rigs: readRigsFlag(search) };
}

/** What a renderer draws: `ArtOptions` first, else the URL (`search`, null in a worker), else the defaults. */
export function resolveRestyleLook(art: ArtOptions, search: string | null): RestyleLook {
  const fromUrl = search !== null ? readRestyleLook(search) : { lineLook: DEFAULT_LINE_LOOK, rigs: true };
  return {
    lineLook: art.lineLook !== undefined ? art.lineLook : fromUrl.lineLook,
    rigs: art.rigs ?? fromUrl.rigs,
  };
}

/** Init step (`initSceneAndOverlays`): set the connector line look and build the
 *  one `StructureRigs` the swarm updater poses, on either renderer path. */
export function applyRestyleLook(
  connectorRenderer: { lineLook: LineLook | null },
  swarmUpdaterCtx: { structureRigs?: StructureRigs },
  shipContainer: Container,
  art: ArtOptions,
  search: string | null,
): RestyleLook {
  const look = resolveRestyleLook(art, search);
  connectorRenderer.lineLook = look.lineLook;
  if (look.rigs) swarmUpdaterCtx.structureRigs = new StructureRigs(shipContainer);
  return look;
}
