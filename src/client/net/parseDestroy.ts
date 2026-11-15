/**
 * The `destroy` trust boundary (invariant #3): every inbound `destroy`
 * parses through the shared strict `DestroyEventSchema`; a malformed one is
 * dropped (null) with a sampled warning and never reaches game logic.
 *
 * `vaporised` (fracture v11): a cut kill (heavy beam / railgun) left no
 * wreck piece. The client skips the dying-hull hold for it and plays the
 * death explosion's vaporise variant (capital-destruction.md "Burn-away and
 * vaporised").
 *
 * Pure (schema in, event-or-null out) so the drop is unit-testable without a
 * live room, like `parseWelcome`.
 */
import { DestroyEventSchema, type DestroyEvent } from '@shared-types/messages';
import { logEvent } from '../debug/ClientLogger';

/** Warn on the first malformed `destroy`, then on every Nth. */
export const DESTROY_DROP_WARN_EVERY = 50;

let dropped = 0;

/** Parse an inbound `destroy` payload. Malformed: sampled log + null (the
 *  caller drops the message). */
export function parseDestroy(raw: unknown): DestroyEvent | null {
  const parsed = DestroyEventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  dropped++;
  if (dropped % DESTROY_DROP_WARN_EVERY === 1) {
    logEvent('destroy_malformed_dropped', {
      dropped,
      issues: parsed.error.issues.length,
      firstIssue: parsed.error.issues[0]?.message ?? 'unknown',
    });
  }
  return null;
}

/** Tests only: reset the drop sample counter. */
export function resetDestroyDropCountForTest(): void {
  dropped = 0;
}
