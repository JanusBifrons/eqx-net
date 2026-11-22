/**
 * Structure break-up T6: `spawnScrapFromDrone`'s structure (kind 2) branch.
 * A destroyed structure breaks into wreck pieces through the room host
 * (`spawnStructureWreck`) when the room's switch is on and the structure
 * breaks (`structureBreaks`: built, not a gate); otherwise nothing. Never
 * the ship / scrap fallback (`getShipKind` would read it as a fighter).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared-types/shipKinds.js', async (orig) => {
  const real = await orig<typeof import('../../shared-types/shipKinds.js')>();
  return { ...real, getShipKind: vi.fn(real.getShipKind) };
});

import { getShipKind } from '../../shared-types/shipKinds.js';
import { spawnScrapFromDrone, type DroneScrapHost } from './ScrapSpawner.js';
import { SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { SAB_TOTAL_BYTES } from '../../shared-types/sabLayout.js';

function host(o: { on?: boolean; wrecks?: boolean; kind?: string; built?: boolean; vaporised?: boolean } = {}) {
  const structure = o.kind === undefined ? undefined : { kind: o.kind, isConstructed: o.built ?? true };
  const spawnFromDeath = vi.fn();
  const f32 = new Float32Array(SAB_TOTAL_BYTES / 4);
  return {
    spawnFromDeath,
    sabF32: () => f32,
    scrapSpawner: () => ({ spawnFromDeath }),
    hasCapitalWrecks: () => o.wrecks ?? true,
    wreckKindAllowed: () => true,
    spawnCapitalWreck: vi.fn(() => false),
    structureWrecksOn: () => o.on ?? true,
    structureOf: () => structure,
    spawnStructureWreck: vi.fn(() => o.vaporised ?? false),
  } satisfies DroneScrapHost & { spawnFromDeath: unknown };
}

const rec = { id: 'st-1', entityId: 1, slot: 0, kind: SWARM_KIND_STRUCTURE, radius: 50 } as SwarmEntityRecord;

describe('spawnScrapFromDrone — structure branch (structure break-up T6)', () => {
  beforeEach(() => vi.mocked(getShipKind).mockClear());

  it('switch on, a built solar: breaks through spawnStructureWreck, never the ship path', () => {
    const h = host({ kind: 'solar' });
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).toHaveBeenCalledWith(rec);
    expect(h.spawnCapitalWreck).not.toHaveBeenCalled();
    expect(h.spawnFromDeath).not.toHaveBeenCalled();
    expect(getShipKind).not.toHaveBeenCalled();
  });

  it('passes a vaporised break-up through', () => {
    expect(spawnScrapFromDrone(host({ kind: 'capital', vaporised: true }), rec)).toBe(true);
  });

  it('switch off: nothing (the structure just goes)', () => {
    const h = host({ kind: 'solar', on: false });
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).not.toHaveBeenCalled();
    expect(h.spawnFromDeath).not.toHaveBeenCalled();
    expect(getShipKind).not.toHaveBeenCalled();
  });

  it('no wreck subsystem (both ship switches off): nothing', () => {
    const h = host({ kind: 'solar', wrecks: false });
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).not.toHaveBeenCalled();
  });

  it('a gate never breaks', () => {
    const h = host({ kind: 'shield_gate' });
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).not.toHaveBeenCalled();
    expect(getShipKind).not.toHaveBeenCalled();
  });

  it('an unbuilt structure (blueprint / frame) never breaks', () => {
    const h = host({ kind: 'solar', built: false });
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).not.toHaveBeenCalled();
  });

  it('a structure missing from the registry: nothing, never the ship path', () => {
    const h = host();
    expect(spawnScrapFromDrone(h, rec)).toBe(false);
    expect(h.spawnStructureWreck).not.toHaveBeenCalled();
    expect(h.spawnFromDeath).not.toHaveBeenCalled();
    expect(getShipKind).not.toHaveBeenCalled();
  });
});
