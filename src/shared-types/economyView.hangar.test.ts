import { describe, expect, it } from 'vitest';
import { PlayerEconomyViewSchema } from './economy.js';

/** Join flow stage 5: the Hangar reads credits and free launches from
 *  GET /trade/economy before the pilot is in a room. Both sides share this
 *  schema (#15); an old server without the fields still parses. */
describe('economy view carries the Hangar purse', () => {
  const base = { econVersion: 1, rep: { drones: 0, robots: 0, traders: 0 }, deals: [], history: [] };

  it('accepts a wallet in launch debt and the free launches left', () => {
    const v = PlayerEconomyViewSchema.parse({ ...base, wallet: -2500, freeLaunches: 3 });
    expect(v.wallet).toBe(-2500);
    expect(v.freeLaunches).toBe(3);
  });

  it('parses without them (older server)', () => {
    expect(PlayerEconomyViewSchema.safeParse(base).success).toBe(true);
  });
});
