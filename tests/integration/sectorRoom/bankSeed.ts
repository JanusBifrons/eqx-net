/**
 * Test helper — seed a player's CREDITS without farming kills (a bespoke
 * trigger, root CLAUDE.md "Test-harness philosophy").
 *
 * Economy v2 W1: credits are virtual — one WALLET balance per player, never in
 * a hold — so this simply credits the wallet. (Pre-W1 it planted a Capital
 * holding the credits; the name is kept so callers read unchanged.)
 */
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWallet } from '../../../src/server/db/PersistenceWorker.js';

export function seedBankCredits(_room: SectorRoom, owner: string, credits: number): void {
  getWallet().credit(owner, credits, 'test_seed');
}
