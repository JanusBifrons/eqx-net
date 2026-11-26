/**
 * Edge placement slice 2 (fence run): the sent-but-not-landed run of fence
 * posts, drawn in `ConnectorRenderer.drawPlacementPreview`'s pass (same
 * `gfx`, no second renderer). `run` is the placement preview's flat (x, y)
 * corner list (`PlacementPreview.run`); a NaN pair breaks the line between
 * two clicks' paths. Each corner gets a post ring, each step between two
 * corners the selected-link line (the beam the server's auto-connect makes).
 * Allocation-free (#14).
 */
import type { Graphics } from 'pixi.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { previewLineVisualParams } from './connectorVisual.js';

/** Post ghost alpha: dim, like the sent (pending) structure ghost. */
const POST_ALPHA = 0.55;

/** Draw the pending run into `gfx` (Pixi space: Y flipped). Returns the
 *  number of post ghosts drawn (a probe count). */
export function drawPendingRun(gfx: Graphics, run: readonly number[] | undefined, scale: number): number {
  if (run === undefined || run.length < 2) return 0;
  const line = previewLineVisualParams('selected', scale);
  let px = NaN, py = NaN;
  for (let n = 0; n + 1 < run.length; n += 2) {
    const x = run[n]!, y = run[n + 1]!;
    if (Number.isFinite(px) && Number.isFinite(x) && (px !== x || py !== y)) {
      gfx.moveTo(px, -py);
      gfx.lineTo(x, -y);
      gfx.stroke({ color: line.color, alpha: line.alpha, width: line.width });
    }
    px = x; py = y;
  }
  const r = getStructureKind(DECK_FENCE_POST_KIND).radius;
  let posts = 0;
  for (let n = 0; n + 1 < run.length; n += 2) {
    const x = run[n]!, y = run[n + 1]!;
    if (!Number.isFinite(x)) continue;
    gfx.circle(x, -y, r);
    gfx.stroke({ color: line.color, alpha: POST_ALPHA, width: line.width });
    posts++;
  }
  return posts;
}
