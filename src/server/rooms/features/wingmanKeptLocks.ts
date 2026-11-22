/**
 * RTS capital S2 — an AI-flown hull keeps the locks it holds (owner rule
 * 2026-11-22: the pilot's locks, moved to the hull when they hand it over,
 * stay until the target dies or leaves lock range). The lock-side helpers
 * `WingmanPilots.tickWingmanTargets` uses: which group holds a live lock, and
 * the brain id the hull's kept lock names (fed to the AI pilot brain's
 * `setKeptLockTarget`, so its pick follows the lock). Per-tick path (#14):
 * the id is cached per hull, a string is built only when the lock changes.
 */
import type { IAiBehaviour } from '../../../core/contracts/IAiBehaviour.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { LockSubsystem, WireGroup } from '../LockSubsystem.js';

/** A weapon group holds a lock that is not draining (released). */
export function holdsLiveLock(grp: WireGroup): boolean {
  for (let i = 0; i < grp.l.length; i++) if (grp.l[i]!.r !== 1) return true;
  return false;
}

/** What the kept-lock lookup reads from the room (getters read the live field). */
export interface WingmanKeptLocksHost {
  wingmanLocks(): Pick<LockSubsystem, 'wireFor'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
}

export class WingmanKeptLocks {
  /** Per hull: its kept lock's key and the brain id it names (cache). */
  private readonly keptLockIds = new Map<string, { key: string; id: string | null }>();

  constructor(private readonly h: WingmanKeptLocksHost) {}

  /** Point hull 'sid''s brain at its kept lock (`on`), or lift it. */
  steer(hb: IAiBehaviour | null, sid: string, on: boolean): void {
    if (hb?.setKeptLockTarget !== undefined) hb.setKeptLockTarget(on ? this.keptLockTarget(sid) : null);
  }

  /** The hull left the AI pilot: drop its cache entry. */
  forget(sid: string): void { this.keptLockIds.delete(sid); }

  /** The brain id of the first live lock hull 'sid' holds (`s:<entityId>` ⇒
   *  the swarm record id, `p:<id>` ⇒ that id), or null. Cached per hull: a
   *  string is built only when the lock changes. */
  keptLockTarget(sid: string): string | null {
    const groups = this.h.wingmanLocks().wireFor(sid);
    if (groups === undefined) return null;
    let key: string | null = null;
    for (let g = 0; g < groups.length && key === null; g++) {
      const l = groups[g]!.l;
      for (let i = 0; i < l.length; i++) if (l[i]!.r !== 1) { key = l[i]!.t; break; }
    }
    if (key === null) return null;
    const cached = this.keptLockIds.get(sid);
    if (cached !== undefined && cached.key === key) return cached.id;
    let id: string | null;
    if (key.startsWith('s:')) id = this.h.swarmRegistry.getByEntityId(Number(key.slice(2)))?.id ?? null;
    else id = key.startsWith('p:') ? key.slice(2) : null;
    if (cached !== undefined) { cached.key = key; cached.id = id; } else this.keptLockIds.set(sid, { key, id });
    return id;
  }
}
