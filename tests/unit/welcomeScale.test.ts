/**
 * Diagnostic capture 2026-11-05T16-42-11Z-v5ga3m (phone, LAN host, 2× B):
 * after a sector handoff the client logged `ship_scale_mismatch` server 1 / A
 * vs client 2 / B, though both sides ran 2× B. The server left the scale off
 * the welcome at the default ("so 1× is unchanged") and the client reads a
 * missing scale as 1× / A, so once the default became 2× B every correct
 * welcome read as a mismatch, and its suggested fix (`?shipScale=1`) would
 * cause the real desync. Both halves of the contract live in
 * shipScale/welcomeScale.ts; this runs the server's stamp through the
 * client's check (invariant #15).
 */
import { describe, expect, it } from 'vitest';
import { shipScaleMismatch, stampShipScale } from '../../src/shared-types/shipScale/welcomeScale.js';
import { SHIP_SCALE, SHIP_TUNING } from '../../src/shared-types/shipScale/config.js';

describe('ship scale on the welcome', () => {
  it('a welcome stamped by this server never reads as a mismatch on a client at the same config', () => {
    const welcome = stampShipScale({ type: 'welcome' as const, playerId: 'p' });
    expect(shipScaleMismatch(welcome)).toBeNull();
  });

  it('the welcome always names the scale, so a client can tell any server apart', () => {
    const welcome = stampShipScale({ type: 'welcome' as const, playerId: 'p' });
    expect(welcome.shipScale).toBe(SHIP_SCALE);
    expect(welcome.shipTuning).toBe(SHIP_TUNING);
  });

  it('a server at another scale is reported, with that scale as the fix', () => {
    const other = SHIP_SCALE === 1 ? 2 : 1;
    const m = shipScaleMismatch({ shipScale: other, shipTuning: SHIP_TUNING });
    expect(m).toMatchObject({ server: other, client: SHIP_SCALE });
    expect(m?.fix).toContain(`shipScale=${other}`);
  });
});
