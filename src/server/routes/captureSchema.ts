import { z } from 'zod';

/**
 * Max `logs` entries a single diagnostic capture may carry.
 *
 * MUST stay >= the client diag ring size `DIAG_MAX_ENTRIES` in
 * `src/client/debug/ClientLogger.ts` (currently 30000). When `?diag=1`
 * the FULL ring is POSTed to `/diag/capture`, so a lower cap 400s a
 * perfectly valid capture. Regression 2026-05-16: the ring was raised
 * 2000 -> 30000 for the warp-out transit timeline but this cap was left
 * at 2000, 400-ing every >2000-entry capture. The server zone cannot
 * import the client const (zone boundary, CI-enforced), so the two are
 * kept in sync BY HAND — change both together. Locked by
 * `captureSchema.test.ts` (unit) + the diagRouter integration test.
 */
export const DIAG_CAPTURE_MAX_LOG_ENTRIES = 30000;

/**
 * Shape of the `POST /diag/capture` body. Extracted from `diagRouter.ts`
 * into this pure (zod-only) module so it is unit-testable WITHOUT the
 * server's heavy transitive imports (`node:sqlite` via Database /
 * PersistenceWorker) that otherwise force the diag tests to be
 * integration-only. `logs` is free-shape per entry (`window.__eqxLogs`
 * carries many tag types incl. nested object/array `data`); the only
 * operationally-meaningful structural constraint is the entry-count cap.
 */
export const captureSchema = z.object({
  note: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  viewport: z.object({ w: z.number(), h: z.number() }).optional(),
  stats: z.record(z.unknown()).optional(),
  /** Wall-clock ms epoch at client boot, so client `ts` (perf.now) and server `ts` (wall) can be aligned. */
  clientEpochMs: z.number().optional(),
  /** Ring-buffer entries from `window.__eqxLogs`. Free-shape per entry. */
  logs: z.array(z.record(z.unknown())).max(DIAG_CAPTURE_MAX_LOG_ENTRIES),
}).strict();

export type CaptureBody = z.infer<typeof captureSchema>;
