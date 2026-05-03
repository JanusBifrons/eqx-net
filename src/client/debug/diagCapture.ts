/**
 * Captures the client-side diagnostic ring buffer (`window.__eqxLogs`),
 * the latest `gameClient.stats`, and basic environment info, and POSTs it
 * to the dev-only `/diag/capture` endpoint. The server writes one JSON file
 * per capture under `diag/captures/`.
 *
 * Used to diagnose live-device issues (mobile corr rate, RAF jitter, etc.)
 * without copy-pasting from devtools.
 */
import type { LogEntry } from './ClientLogger';

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
  filename?: string;
  error?: string;
  bytes?: number;
}

declare global {
  interface Window {
    __eqxLogs?: LogEntry[];
  }
}

/**
 * POST the current ring buffer + stats + UA to `/diag/capture`.
 * Resolves with the server's response or an error string.
 */
export async function captureDiagnostic(input: CaptureInput = {}): Promise<CaptureResult> {
  const logs: LogEntry[] = (typeof window !== 'undefined' && window.__eqxLogs) ? [...window.__eqxLogs] : [];

  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
  const viewport = typeof window !== 'undefined'
    ? { w: window.innerWidth, h: window.innerHeight }
    : undefined;

  const body: Record<string, unknown> = { logs };
  if (input.note !== undefined) body['note'] = input.note;
  if (input.stats !== undefined) body['stats'] = input.stats;
  if (userAgent !== undefined) body['userAgent'] = userAgent;
  if (viewport !== undefined) body['viewport'] = viewport;

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
    const json = await res.json() as { ok: boolean; filename?: string; bytes?: number };
    return json;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
