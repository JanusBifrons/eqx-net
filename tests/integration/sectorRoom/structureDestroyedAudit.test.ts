/**
 * Gameplay audit log — headline regression lock (root CLAUDE.md invariant
 * #13: the test lives where the bug lives). Drives a real structure to
 * destruction through the authoritative damage path (`applyDamage` →
 * leaf death → `evictSwarmEntity`) and asserts a `structure_destroyed`
 * audit record with the owner / kind / sector / attacker context that
 * answers "what happened to my base?".
 *
 * Written to FAIL before the `evictSwarmEntity` audit hook exists (no record
 * is captured); the hook makes it green. The `setAuditSink` seam captures
 * records without constructing the pino-roll logger or touching disk.
 *
 * Plan: glittery-herding-quokka (Phase A).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { setAuditSink, type AuditEvent } from '../../../src/server/audit/GameplayAuditLog.js';

describe('SectorRoom integration — structure destruction is audited', () => {
  let harness: SectorTestHarness;

  afterEach(async () => {
    setAuditSink(null);
    if (harness) await harness.cleanup();
  });

  it('emits structure_destroyed + base_destroyed when a Capital is destroyed', async () => {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
    });
    await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const capital = [...internals.structureRegistry.all()].find((s) => s.kind === 'capital');
    expect(capital).toBeDefined();

    const captured: AuditEvent[] = [];
    setAuditSink((rec) => captured.push(rec));

    // Overkill the Capital in one authoritative hit (structures are shieldless).
    internals.applyDamage(capital!.id, 'swarm-99', 999_999);

    const destroyed = captured.find((e) => e.event === 'structure_destroyed');
    expect(destroyed, 'a structure_destroyed audit event was recorded').toBeDefined();
    expect((destroyed as Extract<AuditEvent, { event: 'structure_destroyed' }>).owner).toBe(capital!.owner);
    expect((destroyed as Extract<AuditEvent, { event: 'structure_destroyed' }>).kind).toBe('capital');
    expect((destroyed as Extract<AuditEvent, { event: 'structure_destroyed' }>).attackerId).toBe('swarm-99');

    // A Capital is the base — a derived base_destroyed rides alongside.
    expect(captured.some((e) => e.event === 'base_destroyed')).toBe(true);
  }, 25_000);
});
