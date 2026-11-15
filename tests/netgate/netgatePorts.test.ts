/**
 * Locks the netgate port lane: NETGATE_PORT_OFFSET moves every port the run
 * uses, and the Playwright child's E2E lane (global setup token mint,
 * baseURL, SERVER_URL) resolves to the gate's own server, never :2567.
 */
import { describe, expect, it } from 'vitest';
import { e2ePortsForOffset, parsePortOffset } from '../e2e/helpers/ports';
import { resolveNetgatePorts } from './netgatePorts';

describe('resolveNetgatePorts', () => {
  it('offset 0 is the canonical set', () => {
    const p = resolveNetgatePorts({});
    expect([p.server, p.proxyBase, p.proxyHead, p.viteBase, p.viteHead]).toEqual([
      2567, 2568, 2569, 5274, 5273,
    ]);
    expect(p.playwrightEnv).toEqual({
      EQX_E2E_PORT_OFFSET: '0',
      PLAYWRIGHT_SERVER_URL: 'http://localhost:2567',
      PLAYWRIGHT_BASE_URL: 'http://localhost:5173',
    });
  });

  it('shifts every port by the offset', () => {
    const p = resolveNetgatePorts({ NETGATE_PORT_OFFSET: '300' });
    expect(p.offset).toBe(300);
    expect([p.server, p.proxyBase, p.proxyHead, p.viteBase, p.viteHead]).toEqual([
      2867, 2868, 2869, 5574, 5573,
    ]);
  });

  it("hands Playwright the same lane, so global setup mints from the gate's server", () => {
    const p = resolveNetgatePorts({ NETGATE_PORT_OFFSET: '300' });
    const childOffset = parsePortOffset(p.playwrightEnv.EQX_E2E_PORT_OFFSET);
    const child = e2ePortsForOffset(childOffset);
    expect(child.server).toBe(p.server);
    expect(p.playwrightEnv.PLAYWRIGHT_SERVER_URL).toBe(`http://localhost:${p.server}`);
    expect(p.playwrightEnv.PLAYWRIGHT_BASE_URL).toBe(`http://localhost:${child.client}`);
  });

  it('baseURL is neither arm (storageState must stay symmetric across arms)', () => {
    const p = resolveNetgatePorts({ NETGATE_PORT_OFFSET: '7' });
    const base = new URL(p.playwrightEnv.PLAYWRIGHT_BASE_URL).port;
    expect([String(p.viteBase), String(p.viteHead)]).not.toContain(base);
  });

  it('rejects a malformed offset with the netgate name', () => {
    expect(() => resolveNetgatePorts({ NETGATE_PORT_OFFSET: '-1' })).toThrow(/NETGATE_PORT_OFFSET/);
    expect(() => resolveNetgatePorts({ NETGATE_PORT_OFFSET: 'abc' })).toThrow(/NETGATE_PORT_OFFSET/);
  });
});
