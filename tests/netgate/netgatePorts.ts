/**
 * Netgate port lane (NETGATE_PORT_OFFSET, default 0) — pure, unit-locked.
 *
 * The gate's game server sits on the E2E lane's server port (2567+N), so the
 * Playwright child gets `EQX_E2E_PORT_OFFSET=N` and `tests/e2e/helpers/ports.ts`
 * (global setup's token mint, `baseURL`, `SERVER_URL`) lands on the same lane.
 * One offset scheme, not two. The two Vite arms and two proxies sit beside it.
 */
import { e2ePortsForOffset, parsePortOffset } from '../e2e/helpers/ports';

export interface NetgatePorts {
  offset: number;
  server: number;
  proxyBase: number; // baseline arm → proxy
  proxyHead: number; // HEAD arm → proxy
  viteBase: number;
  viteHead: number;
  /** Env for the Playwright child so every URL it derives follows the lane. */
  playwrightEnv: {
    EQX_E2E_PORT_OFFSET: string;
    PLAYWRIGHT_SERVER_URL: string;
    PLAYWRIGHT_BASE_URL: string;
  };
}

export function resolveNetgatePorts(env: Record<string, string | undefined>): NetgatePorts {
  const offset = parsePortOffset(env['NETGATE_PORT_OFFSET'], 'NETGATE_PORT_OFFSET');
  const { server, client } = e2ePortsForOffset(offset);
  return {
    offset,
    server,
    proxyBase: 2568 + offset,
    proxyHead: 2569 + offset,
    viteBase: 5274 + offset,
    viteHead: 5273 + offset,
    // Explicit URLs too, so an override inherited from the caller's shell
    // cannot point global setup at another session's server. baseURL is the
    // lane default on purpose (NOT an arm): storageState must cover neither arm,
    // or one arm would load with the e2e pause flag and the A/B turns asymmetric.
    playwrightEnv: {
      EQX_E2E_PORT_OFFSET: String(offset),
      PLAYWRIGHT_SERVER_URL: `http://localhost:${server}`,
      PLAYWRIGHT_BASE_URL: `http://localhost:${client}`,
    },
  };
}
