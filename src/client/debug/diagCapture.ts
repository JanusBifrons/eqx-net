/**
 * Captures the client-side diagnostic ring buffer (`window.__eqxLogs`),
 * the latest `gameClient.stats`, and basic environment info, and POSTs it
 * to the dev-only `/diag/capture` endpoint. The server writes one DIRECTORY
 * per capture under `diag/captures/<timestamp>-<id>/` containing a small
 * `summary.json` plus sibling NDJSON files grouped by purpose. See
 * `docs/architecture/diagnostic-captures.md`.
 *
 * Used to diagnose live-device issues (mobile corr rate, RAF jitter, etc.)
 * without copy-pasting from devtools.
 */
import type { LogEntry } from './ClientLogger';
import { isAutoCaptureEnabled } from './ClientLogger';
import { getStreamingSessionId } from './streamingDiag';

interface CaptureInput {
  /** Free-form note from the user (e.g. "corr feels really bad"). */
  note?: string;
  /** Latest `gameClient.stats` snapshot. */
  stats?: Record<string, unknown>;
  /** Optional override of the server URL (defaults to current origin). */
  serverUrl?: string;
}

export interface CaptureResult {
  ok: boolean;
  /** Directory name (e.g. `2026-05-09T08-30-00-000Z-abc123`). Same value as `dir`; preserved for older callers. */
  filename?: string;
  /** Directory name written under `diag/captures/`. */
  dir?: string;
  error?: string;
  bytes?: number;
  /**
   * Set when `?autocapture=1` was active and the manual Capture call
   * was a no-op. The streaming session is already auto-saving to disk
   * under `dir` (the streaming sessionId). UI callers should show a
   * toast pointing at this rather than treating it as failure.
   * Plan: streaming auto-capture, Phase 4 (2026-05-21).
   */
  noopBecauseStreaming?: boolean;
}

declare global {
  interface Window {
    __eqxLogs?: LogEntry[];
    __eqxEpoch?: number;
  }
}

/**
 * POST the current ring buffer + stats + UA to `/diag/capture`.
 * Resolves with the server's response or an error string.
 *
 * Phase 4 short-circuit (plan: streaming auto-capture, 2026-05-21):
 * when `?autocapture=1` is set, this is a no-op — the streaming module
 * is already POSTing to `/diag/capture/stream` every 2s. Returns
 * `{ ok: true, noopBecauseStreaming: true, dir: <streamingSessionId> }`
 * so the UI can show a toast pointing at the auto-saved session
 * instead of duplicating the capture work.
 */
export async function captureDiagnostic(input: CaptureInput = {}): Promise<CaptureResult> {
  if (isAutoCaptureEnabled()) {
    const streamingId = getStreamingSessionId();
    return {
      ok: true,
      noopBecauseStreaming: true,
      dir: streamingId ?? undefined,
      filename: streamingId ?? undefined,
    };
  }
  const logs: LogEntry[] = (typeof window !== 'undefined' && window.__eqxLogs) ? [...window.__eqxLogs] : [];

  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
  const viewport = typeof window !== 'undefined'
    ? { w: window.innerWidth, h: window.innerHeight }
    : undefined;

  const clientEpochMs = typeof window !== 'undefined' ? window.__eqxEpoch : undefined;

  const body: Record<string, unknown> = { logs };
  if (input.note !== undefined) body['note'] = input.note;
  if (input.stats !== undefined) body['stats'] = input.stats;
  if (userAgent !== undefined) body['userAgent'] = userAgent;
  if (viewport !== undefined) body['viewport'] = viewport;
  if (clientEpochMs !== undefined) body['clientEpochMs'] = clientEpochMs;

  const url = (input.serverUrl ?? '') + '/diag/capture';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; filename?: string; dir?: string; bytes?: number };
    return json;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
