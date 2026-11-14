import { describe, it, expect } from 'vitest';
import { COLLISION_RESEND_TICKS } from '../../src/server/net/CollisionBroadcastGate.js';
import { SHIELD_CONTACT_MIN_MS } from '../../src/client/net/collisionShieldContacts.js';
import { createCollisionGuard } from '../../src/client/net/applyCollisionResolved.js';

/** #15: the server re-sends a lasting contact at least as often as the client
 *  can use it (one shield contact per 150 ms; 4 velocity mirrors per ship per
 *  second), so gating the broadcast changes no drawn or predicted result. */
describe('collision_resolved resend cadence matches what the client keeps', () => {
  it('re-sends at least as often as the shield-contact and velocity limits', () => {
    const resendMs = COLLISION_RESEND_TICKS * (1000 / 60);
    expect(resendMs).toBeLessThanOrEqual(SHIELD_CONTACT_MIN_MS);
    const guard = createCollisionGuard();
    expect(resendMs).toBeLessThanOrEqual(guard.rateLimitWindowMs / guard.rateLimitCount);
  });
});
