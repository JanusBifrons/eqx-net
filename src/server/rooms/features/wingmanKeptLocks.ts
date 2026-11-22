/**
 * RTS capital S2 — an AI-flown hull keeps the locks it holds (owner rule
 * 2026-11-22: the pilot's locks, moved to the hull when they hand it over,
 * stay until the target dies or leaves lock range). The lock-side helpers
 * `WingmanPilots.tickWingmanTargets` uses: which group holds a kept lock, and
 * the brain id the hull's kept lock names (fed to the AI pilot brain's
 * `setKeptLockTarget`, so its pick follows the lock). Per-tick path (#14):
 * the id is cached per hull, a string is built only when the lock changes.
 *
 * Only the PILOT's locks are kept. A lock the AI pilot took itself
 * (`noteAiLock`) follows its pick as before: pinning those bypassed the
 * pick's spread-targets claims, so a squadron piled onto one cube from every
 * side and shot across each other (wingmanFightsRobots 2026-11-22: squadmate
 * hits 3-12 per fight, vs 1-5 before kept locks).
 */
import type { IAiBehaviour } from '../../../core/contracts/IAiBehaviour.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { LockSubsystem, WireGroup } from '../LockSubsystem.js';

/** What the kept-lock lookup reads from the room (getters read the live field). */
export interface WingmanKeptLocksHost {
  wingmanLocks(): Pick<LockSubsystem, 'wireFor'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
}

export class WingmanKeptLocks {
  /** Per hull: its kept lock's key and the brain id it names (cache). */
  private readonly keptLockIds = new Map<string, { key: string; id: string | null }>();
  /** Per hull: group id → the lock key its AI pilot requested there. */
  private readonly aiLocks = new Map<string, Map<string, string>>();

  constructor(private readonly h: WingmanKeptLocksHost) {}

  /** Point hull 'sid''s brain at its kept lock (`on`), or lift it. */
  steer(hb: IAiBehaviour | null, sid: string, on: boolean): void {
    if (hb?.setKeptLockTarget !== undefined) hb.setKeptLockTarget(on ? this.keptLockTarget(sid) : null);
  }

  /** The hull left (or re-joined) the AI pilot: drop its entries. */
  forget(sid: string): void { this.keptLockIds.delete(sid); this.aiLocks.delete(sid); }

  /** Hull 'sid''s AI pilot requested 'key' on group 'gid': not a kept lock. */
  noteAiLock(sid: string, gid: string, key: string): void {
    let m = this.aiLocks.get(sid);
    if (m === undefined) { m = new Map(); this.aiLocks.set(sid, m); }
    m.set(gid, key);
  }

  /** Group 'grp' of hull 'sid' holds a kept lock: a live (not draining) lock
   *  its AI pilot did not take itself. */
  holdsKeptLock(sid: string, grp: WireGroup): boolean {
    const mine = this.aiLocks.get(sid)?.get(grp.id);
    for (let i = 0; i < grp.l.length; i++) if (grp.l[i]!.r !== 1 && grp.l[i]!.t !== mine) return true;
    return false;
  }

  /** The brain id of the first kept lock hull 'sid' holds (`s:<entityId>` ⇒
   *  the swarm record id, `p:<id>` ⇒ that id), or null. Cached per hull: a
   *  string is built only when the lock changes. */
  keptLockTarget(sid: string): string | null {
    const groups = this.h.wingmanLocks().wireFor(sid);
    if (groups === undefined) return null;
    const ai = this.aiLocks.get(sid);
    let key: string | null = null;
    for (let g = 0; g < groups.length && key === null; g++) {
      const l = groups[g]!.l, mine = ai?.get(groups[g]!.id);
      for (let i = 0; i < l.length; i++) if (l[i]!.r !== 1 && l[i]!.t !== mine) { key = l[i]!.t; break; }
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
