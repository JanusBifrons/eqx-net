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
export const DIAG_CAPTURE_MAX_LOG_ENTRIES = 60000;

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

/**
 * Streaming-batch schema for `POST /diag/capture/stream`.
 *
 * Plan: streaming auto-capture, Phase 2 (2026-05-21). Each batch
 * carries up to 5000 ring entries collected on the client since the
 * previous successful POST. First batch (`batchSeq === 0`) carries
 * the metadata fields (userAgent, viewport, clientEpochMs); subsequent
 * batches may omit them.
 *
 * `sessionId` is a client-generated `<ISO timestamp>-<random>` string
 * mirroring the manual-capture directory naming convention so
 * streaming sessions sort alongside manual captures under
 * `diag/captures/`.
 *
 * `batchSeq` is monotonic per session — the server rejects batches
 * where `batchSeq <= lastAppliedSeq` with 409 (idempotent retry safe).
 * `final: true` signals the session is ending; the server can
 * finalize and write `summary.json` (Phase 2.1, deferred).
 */
export const streamingBatchSchema = z.object({
  sessionId: z.string().min(8).max(100),
  batchSeq: z.number().int().min(0),
  final: z.boolean().optional(),
  userAgent: z.string().max(500).optional(),
  viewport: z.object({ w: z.number(), h: z.number() }).optional(),
  clientEpochMs: z.number().optional(),
  entries: z.array(z.record(z.unknown())).max(5_000),
}).strict();

export type StreamingBatchBody = z.infer<typeof streamingBatchSchema>;
