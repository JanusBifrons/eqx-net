/**
 * Living World P1a-2 test helper — seed BANKED CREDITS for a player in a room
 * without building a base + waiting out a deposit (a bespoke trigger, root
 * CLAUDE.md "Test-harness philosophy"). Adds a bare, built Capital record to
 * the room's StructureRegistry carrying `credits` in its hold. The
 * StorageService's credit sinks (respec, repair) read the registry, so this is
 * all a credit-spend test needs. No swarm entity (it's never rendered or hit).
 */
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { structureKindToIndex } from '../../../src/shared-types/structureKinds.js';

export function seedBankCredits(room: SectorRoom, owner: string, credits: number): void {
  room._internals.structureRegistry.add({
    id: `test-bank-${owner}`,
    owner,
    kind: 'capital',
    subtypeIndex: structureKindToIndex('capital'),
    x: 4_000,
    y: 4_000,
    radius: 80,
    isConstructed: true,
    constructionProgress: 0,
    constructionCost: 0,
    isDeconstructing: false,
    minerals: 0,
    storedPower: 0,
    level: 1,
    hold: { goods: {}, credits, blueprints: [] },
  });
}
