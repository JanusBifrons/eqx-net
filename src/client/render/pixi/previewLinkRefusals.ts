/**
 * Reads the build preview's per-candidate verdicts (`ConnectorRenderer.
 * previewVerdicts`, from the server's own `canConnect`) for the main-thread
 * placement hints. Kept out of `ConnectorRenderer.ts` (god-file cap).
 * Allocation-free.
 */
import type { CanConnectReason } from '../../../core/structures/Grid.js';

interface VerdictSource {
  readonly previewVerdicts: ReadonlyArray<{ readonly reason: CanConnectReason | null }>;
  readonly previewVerdictCount: number;
}

/** How many of the last preview frame's candidate links were refused with
 *  `reason` (published as `RendererFeedback.placementPreviewTooShortCount`
 *  for `'too-short'`). */
export function countPreviewRefusals(r: VerdictSource, reason: CanConnectReason): number {
  let n = 0;
  for (let i = 0; i < r.previewVerdictCount; i++) if (r.previewVerdicts[i]!.reason === reason) n++;
  return n;
}
