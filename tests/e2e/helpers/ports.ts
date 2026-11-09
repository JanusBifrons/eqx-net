/**
 * E2E port lane (EQX_E2E_PORT_OFFSET).
 *
 * Several sessions/worktrees on one machine can each run E2E at once by
 * picking a distinct integer offset N: the game server listens on 2567+N and
 * Vite on 5173+N (HMR on 24678+N), and Vite's proxy targets 2567+N. Offset 0
 * (the default) is the canonical 2567/5173 pair, unchanged.
 *
 * Every spec, helper and `playwright.config.ts` derives its URLs from here,
 * so a hard-coded `localhost:2567` / `localhost:5173` never sneaks back in.
 * The explicit overrides (`PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_SERVER_URL`)
 * still win over the offset-derived defaults.
 */

function parseOffset(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 60_000) {
    throw new Error(`EQX_E2E_PORT_OFFSET must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

export const E2E_PORT_OFFSET = parseOffset(process.env['EQX_E2E_PORT_OFFSET']);
export const E2E_SERVER_PORT = 2567 + E2E_PORT_OFFSET;
export const E2E_CLIENT_PORT = 5173 + E2E_PORT_OFFSET;
export const E2E_HMR_PORT = 24678 + E2E_PORT_OFFSET;

/** Offset-derived defaults (no env override applied). */
export const DEFAULT_BASE_URL = `http://localhost:${E2E_CLIENT_PORT}`;
export const DEFAULT_SERVER_URL = `http://localhost:${E2E_SERVER_PORT}`;

/** Vite origin the browser loads; `PLAYWRIGHT_BASE_URL` overrides. */
export const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
/** Game server origin for direct API calls; `PLAYWRIGHT_SERVER_URL` overrides. */
export const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? DEFAULT_SERVER_URL;
