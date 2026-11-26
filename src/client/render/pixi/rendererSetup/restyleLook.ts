/**
 * Structure restyle scene options, for BOTH renderer paths: the 1g grid line
 * look (`?lineLook=off|pipe|conduit`, cable by default), the 2c rig parts
 * (`?rigs=0` off) and the 0d socket cables (the new-effects flag
 * `ArtOptions.fx`, `?fx=new`: off = the straight lines above). Read from the URL on the main thread (`selectRenderer`) and
 * carried on `ArtOptions` — the render worker has no `window`, so it gets them
 * on BOOT like the structure style. Absent on `ArtOptions` (a renderer built
 * without them, e.g. a test) ⇒ the URL on the main thread, the defaults in a
 * worker.
 */
import type { Container } from 'pixi.js';
import type { ArtOptions } from '../../art/artMode.js';
import { DEFAULT_LINE_LOOK, readLineLook, type LineLook } from '../connectorLineLooks.js';
import { readRigsFlag, StructureRigs } from '../structureRigs.js';
import { StructureDeckPlates } from '../structureDeckPlates.js';
import { DEFAULT_DECK_TEX, readDeckTex, type DeckTex } from '../structureDeckTexture.js';
import { DEFAULT_FENCE_LOOK, readFenceLook, type FenceLook } from '../connectorFenceBeam.js';
import { readZonesFlag } from '../structureDeckZones.js';
import { readApproachFlag } from '../deckApproachLights.js';
import { BuildSlotOutlines, readBuildSlotsFlag } from '../buildSlotOutlines.js';
import { readBuildRingFlag } from '../buildRing.js';

export interface RestyleLook {
  /** Grid line look; null = the pre-restyle thin line. */
  lineLook: LineLook | null;
  /** Draw structure rig parts (pad, crane, hatches). */
  rigs: boolean;
  /** Deck floor look (`?deckTex=plain|a|b`, base platforms). */
  deckTex: DeckTex;
  /** Deck fence link look (`?fenceLook=old|new`, base platforms slice 30). */
  fenceLook: FenceLook;
  /** Deck zone markings (`?zones=on|off`, base platforms slice 33). */
  zones: boolean;
  /** Runway approach lights outside deck fence gates (`?approach=on|off`, default on). */
  approach: boolean;
  /** Free build-slot outlines while placing on a deck (default on; `?buildSlots=off` hides). */
  buildSlots: boolean;
  /** Readable construction: progress ring + wireframe hologram on unbuilt structures (`?buildRing=on|off`, default on). */
  buildRing: boolean;
}

/** The restyle scene options from a URL query string. */
export function readRestyleLook(search: string): RestyleLook {
  return {
    lineLook: readLineLook(search), rigs: readRigsFlag(search), deckTex: readDeckTex(search), fenceLook: readFenceLook(search), zones: readZonesFlag(search),
    approach: readApproachFlag(search), buildSlots: readBuildSlotsFlag(search), buildRing: readBuildRingFlag(search),
  };
}

/** What a renderer draws: `ArtOptions` first, else the URL (`search`, null in a worker), else the defaults. */
export function resolveRestyleLook(art: ArtOptions, search: string | null): RestyleLook {
  const fromUrl = search !== null ? readRestyleLook(search) : { lineLook: DEFAULT_LINE_LOOK, rigs: true, deckTex: DEFAULT_DECK_TEX, fenceLook: DEFAULT_FENCE_LOOK, zones: true, approach: true, buildSlots: true, buildRing: true };
  return {
    lineLook: art.lineLook !== undefined ? art.lineLook : fromUrl.lineLook,
    rigs: art.rigs ?? fromUrl.rigs,
    deckTex: art.deckTex ?? fromUrl.deckTex,
    fenceLook: art.fenceLook ?? fromUrl.fenceLook,
    zones: art.zones ?? fromUrl.zones,
    approach: art.approach ?? fromUrl.approach,
    buildSlots: art.buildSlots ?? fromUrl.buildSlots,
    buildRing: art.buildRing ?? fromUrl.buildRing,
  };
}

/** Init step (`initSceneAndOverlays`): set the connector line look and build the
 *  one `StructureRigs` the swarm updater poses (and the deck floor), on either renderer path. */
export function applyRestyleLook(
  connectorRenderer: { lineLook: LineLook | null; socketCables?: boolean; cables?: { fenceBeams: boolean }; buildRing?: boolean },
  swarmUpdaterCtx: { structureRigs?: StructureRigs; deckPlates?: StructureDeckPlates; socketNubs?: boolean; buildRing?: boolean },
  shipContainer: Container,
  art: ArtOptions,
  search: string | null,
  placementGhostCtx?: { slotOutlines: BuildSlotOutlines | null },
): RestyleLook {
  const look = resolveRestyleLook(art, search);
  connectorRenderer.lineLook = look.lineLook;
  // 0d slice 8: links drawn as socket cables on the server's curve.
  connectorRenderer.socketCables = art.fx === true;
  // Base platforms slice 30: deck fence links as a shield beam (`?fenceLook=new`).
  if (connectorRenderer.cables) connectorRenderer.cables.fenceBeams = look.fenceLook === 'new';
  // 0d slice 10: socket nubs on the structures, same flag.
  swarmUpdaterCtx.socketNubs = art.fx === true;
  // Readable construction: the ring replaces the blueprint fill bar.
  swarmUpdaterCtx.buildRing = look.buildRing;
  connectorRenderer.buildRing = look.buildRing;
  if (look.rigs) swarmUpdaterCtx.structureRigs = new StructureRigs(shipContainer);
  // Base platforms: the deck floor (drawn only while the room's deck flag is on).
  swarmUpdaterCtx.deckPlates = new StructureDeckPlates(shipContainer, look.deckTex, look.zones, look.approach);
  // Base platforms: outline the free build slots while placing (default on; `?buildSlots=off` hides).
  if (placementGhostCtx) placementGhostCtx.slotOutlines = look.buildSlots ? new BuildSlotOutlines(shipContainer) : null;
  return look;
}
