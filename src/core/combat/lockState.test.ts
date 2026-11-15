/**
 * Lock eligibility by swarm kind — the one predicate the server
 * (`SectorRoom.resolveLockTarget`), the client lock line
 * (`ColyseusClient.updateLockGuide`) and missile seekers share (#15).
 */
import { describe, it, expect } from 'vitest';
import { isContactLockKind, isTerrainLockKind, newLock } from './lockState.js';
import {
  SWARM_KIND_ASTEROID, SWARM_KIND_DRONE, SWARM_KIND_SCRAP, SWARM_KIND_STRUCTURE, SWARM_KIND_WRECK,
} from '../../shared-types/swarmWireFormat.js';

describe('swarm lock eligibility', () => {
  it('NPC ships and structures are contacts; asteroids, scrap / loot pods and wreck pieces are neutral terrain', () => {
    expect([SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE].every(isContactLockKind)).toBe(true);
    expect([SWARM_KIND_ASTEROID, SWARM_KIND_SCRAP, SWARM_KIND_WRECK].every(isTerrainLockKind)).toBe(true);
    for (let k = 0; k < 8; k++) expect(isContactLockKind(k) && isTerrainLockKind(k), `kind ${k} in both tiers`).toBe(false);
    expect(isContactLockKind(5) || isTerrainLockKind(5)).toBe(false); // an unknown kind is not lockable
  });

  it('a lock started as non-failsafe (hostile or terrain) skips the failsafe ring', () => {
    expect(newLock('s:1', true).stage).toBe('acquiring');
    expect(newLock('s:1', false).stage).toBe('failsafe');
  });
});
