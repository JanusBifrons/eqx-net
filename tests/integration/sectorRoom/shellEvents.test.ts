/**
 * Shells as events, slice 1 (docs/architecture/shell-events.md §2, §7),
 * through a real SectorRoom: a battleship's 16" salvo reaches the pilot it
 * fires at as a `shell_salvo`, and the shell that hits arrives as a
 * `shell_end` whose point is the `DamageEvent`'s hit point and whose tick puts
 * the hit on the shell's closed-form path (`shellPoseAt`), so the client can
 * draw the flight from the salvo alone and end it where the server did.
 *
 * Room option `shellEvents` (testMode) stands in for `EQX_SHELL_EVENTS=1`.
 * The per-tick `projectiles[]` path still runs beside it in slice 1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';
import {
  ShellEndSchema, ShellSalvoSchema, type ShellEnd, type ShellSalvo,
} from '../../../src/shared-types/messages/shellEvents.js';
import { shellPathEndTick, shellPoseAt } from '../../../src/core/combat/shellFlight.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';

describe('SectorRoom integration — naval shells as events (slice 1)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a 16" hit: the salvo reaches the target, and shell_end matches the DamageEvent', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], shellEvents: true,
      // Same layout as capitalEngagement: the pilot 40° off the bow, 5,000 u.
      dronePoses: [{ kind: 'battleship', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 1_000_000, initialShield: 0, startHostile: true, instantLock: true });
    const salvos: ShellSalvo[] = [];
    const ends: ShellEnd[] = [];
    const hits: DamageEvent[] = [];
    cr.onMessage('shell_salvo', (m: unknown) => {
      const r = ShellSalvoSchema.safeParse(m);
      expect(r.success, 'shell_salvo matches its schema').toBe(true);
      if (r.success) salvos.push(r.data);
    });
    cr.onMessage('shell_end', (m: unknown) => {
      const r = ShellEndSchema.safeParse(m);
      expect(r.success, 'shell_end matches its schema').toBe(true);
      if (r.success) ends.push(r.data);
    });
    cr.onMessage('damage', (e: DamageEvent) => {
      if (e.targetId === pid && e.damage === getWeapon('naval_xl').damage) hits.push(e);
    });
    // Slice 3: the naval shells travel ONLY as events here, never per tick.
    let navalInSnapshots = 0;
    cr.onMessage('snapshot', (snap: { projectiles?: Array<{ weaponId?: string }> }) => {
      for (const p of snap.projectiles ?? []) if (p.weaponId?.startsWith('naval_')) navalInSnapshots++;
    });

    const deadline = Date.now() + 45_000;
    const endFor = (): { id: string; tick: number; x: number; y: number } | undefined => {
      for (const m of ends) for (const [id, tick, x, y] of m.e) {
        if (hits.some((h) => h.hitX === x && h.hitY === y)) return { id, tick, x, y };
      }
      return undefined;
    };
    while (Date.now() < deadline && endFor() === undefined) await new Promise((r) => setTimeout(r, 100));

    expect(hits.length, 'a 16" shell hit the pilot').toBeGreaterThan(0);
    const end = endFor();
    expect(end, 'a shell_end carries the DamageEvent\'s hit point').toBeDefined();
    const salvo = salvos.find((s) => s.sh.some((t) => t[0] === end!.id));
    expect(salvo, 'the pilot was sent the salvo of the shell that hit it').toBeDefined();
    expect(salvo!.w).toBe('naval_xl');
    expect(salvo!.o.startsWith('swarm-')).toBe(true);

    // The hit lies on the closed-form path, on the step the end tick swept.
    const [, x0, y0, vx, vy] = salvo!.sh.find((t) => t[0] === end!.id)!;
    expect(end!.tick).toBeGreaterThanOrEqual(salvo!.t);
    expect(end!.tick).toBeLessThan(shellPathEndTick(salvo!.t, salvo!.n));
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    shellPoseAt(x0, y0, vx, vy, salvo!.t, end!.tick, a);
    shellPoseAt(x0, y0, vx, vy, salvo!.t, end!.tick + 1, b);
    // Distance from the hit point to segment a→b (the shell's radius plus the
    // pilot's hit circle bound how far off the centre line the contact is).
    const dx = b.x - a.x; const dy = b.y - a.y;
    const u = Math.max(0, Math.min(1, ((end!.x - a.x) * dx + (end!.y - a.y) * dy) / (dx * dx + dy * dy)));
    const off = Math.hypot(a.x + u * dx - end!.x, a.y + u * dy - end!.y);
    expect(off, 'the hit point is on the swept step of the closed-form flight').toBeLessThan(1);
    expect(navalInSnapshots, 'no naval shell rides the snapshot when shells are events (slice 3)').toBe(0);
  });
});
