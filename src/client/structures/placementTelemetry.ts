/**
 * Build-placement telemetry (owner playtest 2026-11-27: "nearly everywhere I
 * click it says Off your deck"). Every time the placement ghost lands on a new
 * spot, or its verdict changes, one `build_ghost` line goes into the client
 * log ring (`logEvent`), so the phone lane's streaming capture records every
 * tap and WHY the ghost was refused: the snapped point, the worker's verdict,
 * a main-thread re-check of the same core rule, and the deck facts the
 * `off-deck` rule reads (owner, plate count, own plate under the point, plate
 * centre). `build_ghost` lines land in `combat.ndjson`'s sibling
 * `build.ndjson` (diagRouter BUCKETS).
 *
 * Runs on the main thread from `gameRafLoop` while a ghost is up. Logs only on
 * a change (a new snapped spot, verdict, kind or park state), so a parked
 * ghost logs nothing per frame; the per-frame cost is a few compares (#14).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { OwnerPlateList, plateCentreAtWorldInto } from '../../core/hex/plateSet.js';
import type { PlateIndex } from '../../core/hex/plates.js';
import type { PlacementDeck, PlacementRejection } from '../../core/structures/placementRules.js';
import { logEvent } from '../debug/ClientLogger.js';
import { PlacementGhostVerdict, type GhostPose } from './placementGhostVerdict.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

/** What the last `build_ghost` line said (change detection). */
const last = { kind: '', x: NaN, y: NaN, rejection: null as PlacementRejection | null, stuck: false, seq: 0 };
let taps = 0;

const verdict = new PlacementGhostVerdict();
const pose: GhostPose = { kind: '', x: 0, y: 0, angle: 0 };
const plateList = new OwnerPlateList();
const deckCtx: PlacementDeck = { plates: plateList, owner: '' };
const plateIdx: PlateIndex = { i: 0, j: 0 };

/** Snapped points are exact slot centres: a sub-unit move is the same spot. */
function sameSpot(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

/**
 * Per frame while a ghost is up (after `writePlacementChosen`): log one
 * `build_ghost` line when the ghost's spot, verdict, kind or park state
 * changed. `x`/`y` are the chosen (snapped) point, null before positioning.
 */
export function notePlacementGhost(
  preview: Preview,
  x: number | null,
  y: number | null,
  stuck: boolean,
  rejection: PlacementRejection | null,
  mirror: RenderMirror,
): void {
  const gx = x ?? preview.x;
  const gy = y ?? preview.y;
  if (
    last.kind === preview.kind && sameSpot(last.x, gx) && sameSpot(last.y, gy) &&
    last.rejection === rejection && last.stuck === stuck
  ) return;
  const moved = !(sameSpot(last.x, gx) && sameSpot(last.y, gy)) || last.kind !== preview.kind;
  if (moved) taps++;
  last.kind = preview.kind; last.x = gx; last.y = gy; last.rejection = rejection; last.stuck = stuck;
  last.seq++;
  logEvent('build_ghost', buildGhostLine(preview, gx, gy, x !== null, stuck, rejection, mirror));
}

/** Clear the change detector when placement ends (next ghost logs at once). */
export function resetPlacementTelemetry(): void {
  last.kind = ''; last.x = NaN; last.y = NaN; last.rejection = null; last.stuck = false;
}

/** The `build_ghost` payload (exported for the unit test). */
export function buildGhostLine(
  preview: Preview,
  gx: number,
  gy: number,
  chosen: boolean,
  stuck: boolean,
  rejection: PlacementRejection | null,
  mirror: RenderMirror,
): Record<string, unknown> {
  const plates = preview.deckPlates ?? [];
  const owner = preview.deckOwner;
  let onOwnPlate: boolean | null = null;
  let mainVerdict: PlacementRejection | null | 'n/a' = 'n/a';
  if (preview.deck === true && owner !== undefined) {
    plateList.set(owner, plates);
    deckCtx.owner = owner;
    onOwnPlate = plateList.plateAtWorld(owner, gx, gy);
  }
  if (mirror.swarm) {
    pose.kind = preview.kind; pose.x = gx; pose.y = gy; pose.angle = preview.angle; pose.mirror = preview.mirror === true;
    // No rocks here (the worker's verdict has them): a difference that is not
    // 'overlap-obstacle' / 'plate-blocked' means the two sides disagree.
    mainVerdict = verdict.check(pose, mirror.structures, mirror.swarm, null, preview.deck === true && owner !== undefined ? deckCtx : null);
  }
  const atCentre = plateCentreAtWorldInto(gx, gy, plateIdx);
  return {
    seq: last.seq,
    taps,
    kind: preview.kind,
    x: Math.round(gx * 10) / 10,
    y: Math.round(gy * 10) / 10,
    chosen,
    stuck,
    pending: preview.pending === true,
    rejection,
    mainVerdict,
    deck: preview.deck === true,
    deckOwner: owner ?? null,
    localPlayerId: mirror.localPlayerId ?? null,
    plates: plates.length / 2,
    platesSample: plates.slice(0, 12), // TODO: alloc-debt (logged on change only, not per frame)
    onOwnPlate,
    plateCentre: atCentre ? [plateIdx.i, plateIdx.j] : null,
    structures: mirror.structures?.size ?? 0,
  };
}
