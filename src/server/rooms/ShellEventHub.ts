/**
 * Shells as events, slice 1 (docs/architecture/shell-events.md §2–§5): the
 * server side that turns event shells (`ProjectilePipeline` with
 * `shellEvents`) into `shell_salvo` / `shell_end` messages, the join backlog
 * and the snapshot keyframe.
 *
 * Who receives a shell (§3), decided per shell and per viewer:
 *  1. the viewer fired it, or is its target (`g`);
 *  2. its remaining path (now → `shellPathEndTick`) crosses the viewer's view
 *     square (`shellViewHalfExtent` of the hull they fly);
 *  3. its owner is a wide entity in the viewer's interest (today's rule).
 * New shells are tested at fire time; unsent live shells are re-tested every
 * `SHELL_RETEST_TICKS` against the viewer's current pose. `shell_end` reaches
 * every viewer that was sent the shell. A miss sends nothing.
 *
 * Slice 1 runs BESIDE the per-tick `projectiles[]` path; the client ignores
 * these until slice 2. Steady state allocates nothing (#14): shell records,
 * message objects and tuples are pooled; per-viewer state is a slot index
 * into fixed-size typed arrays on each record.
 */
import {
  shellPathEndTick, shellPoseAt, shellSegmentInView, type ShellPoseMut,
} from '../../core/combat/shellFlight.js';
import {
  SHELL_KEY_PER_SNAPSHOT, SHELL_KEY_PERIOD_TICKS, SHELL_RETEST_TICKS,
  type NavalWeaponId, type ShellEnd, type ShellEndTuple, type ShellKeyRecord,
  type ShellSalvo, type ShellTuple,
} from '../../shared-types/messages/shellEvents.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';

/** Most viewers a room tracks for shell events. A viewer past the cap gets
 *  no events (it still has the per-tick shells while those exist). */
export const SHELL_MAX_VIEWERS = 128;
const SALVO_MAX_SHELLS = 64;
const END_MAX = 256;

/** The viewer as the hub sees it; the room fills one reused object. */
export interface ShellViewer {
  sessionId: string;
  playerId: string;
  /** Ship pose. */
  x: number;
  y: number;
  /** Half-extent of the viewer's widest view (`shellViewHalfExtent`). */
  half: number;
}

export interface ShellEventHubDeps {
  serverTick: () => number;
  /** The owner as the client knows it (`swarm-<eid>` for a drone). */
  wireOwnerId: (ownerId: string) => string;
  /** Rule 3: the owner is a wide entity in this viewer's interest. */
  ownerWideInView: (ownerId: string, sessionId: string) => boolean;
  /** The firer's locked target (a playerId), when it has one. */
  fireTargetOf?: (ownerId: string) => string | undefined;
  /** Call `fn` once per connected viewer with a pose. */
  forEachViewer: (fn: (v: ShellViewer) => void) => void;
  send: (sessionId: string, type: 'shell_salvo' | 'shell_end', msg: ShellSalvo | ShellEnd) => void;
}

class ShellInfo {
  id = '';
  idx = -1;
  salvo = 0;
  owner = '';
  ownerWire = '';
  w: NavalWeaponId = 'naval_s';
  t = 0;
  n = 1;
  g: string | undefined = undefined;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** 1 once this viewer slot was sent the shell. */
  readonly sent = new Uint8Array(SHELL_MAX_VIEWERS);
  /** Tick this viewer slot last got it (salvo or keyframe). */
  readonly keyTick = new Int32Array(SHELL_MAX_VIEWERS);
  ended = false;
  silent = false;
  endTick = 0;
  endX = 0;
  endY = 0;
  endR = 0;
}

type MutSalvo = { -readonly [K in keyof ShellSalvo]: ShellSalvo[K] };

export class ShellEventHub {
  private readonly byId = new Map<string, ShellInfo>();
  private readonly live: ShellInfo[] = [];
  private liveCount = 0;
  private readonly pool: ShellInfo[] = [];
  private readonly fresh: ShellInfo[] = [];
  private freshCount = 0;
  private readonly ended: ShellInfo[] = [];
  private endedCount = 0;

  private readonly slots = new Map<string, number>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private readonly keyCursor = new Int32Array(SHELL_MAX_VIEWERS);

  private salvoCounter = 0;
  private lastOwner = '';
  private lastWeapon = '';
  private lastTick = -1;

  // Pooled outgoing messages (Colyseus encodes synchronously in send()).
  private readonly salvoMsg: MutSalvo = { type: 'shell_salvo', s: 0, o: '', w: 'naval_s', t: 0, n: 1, sh: [] };
  private readonly salvoMsgG: MutSalvo = { type: 'shell_salvo', s: 0, o: '', w: 'naval_s', t: 0, n: 1, g: '', sh: [] };
  private readonly shTuples: ShellTuple[] = [];
  private readonly endMsg: { type: 'shell_end'; e: ShellEndTuple[] } = { type: 'shell_end', e: [] };
  private readonly endTuples: ShellEndTuple[] = [];
  private readonly pose: ShellPoseMut = { x: 0, y: 0 };
  private readonly poseEnd: ShellPoseMut = { x: 0, y: 0 };

  // Per-flush state read by the bound viewer callback.
  private flushTick = 0;
  private flushRetest = false;
  private readonly visitViewer = (v: ShellViewer): void => { this.flushViewer(v); };

  /** Messages sent in the last flush (a count, for tests and budgets). */
  sentSalvos = 0;
  sentEnds = 0;

  constructor(private readonly deps: ShellEventHubDeps) {}

  /** Live event shells (diagnostic). */
  size(): number { return this.liveCount; }

  // ── Pipeline hooks ──────────────────────────────────────────────────────

  onSpawn(projId: string, rec: ProjectileRecord): void {
    const info = this.pool.pop() ?? new ShellInfo();
    info.id = projId;
    info.owner = rec.ownerId;
    info.ownerWire = this.deps.wireOwnerId(rec.ownerId);
    info.w = rec.weaponId as NavalWeaponId;
    info.t = rec.birthTick;
    info.n = rec.maxTicks;
    info.g = this.deps.fireTargetOf?.(rec.ownerId);
    info.x = rec.ox ?? rec.x;
    info.y = rec.oy ?? rec.y;
    info.vx = rec.vx;
    info.vy = rec.vy;
    info.sent.fill(0);
    info.keyTick.fill(0);
    info.ended = false;
    info.silent = false;
    // One salvo per firer per gun per tick: consecutive spawns share an id.
    if (rec.ownerId !== this.lastOwner || rec.weaponId !== this.lastWeapon || rec.birthTick !== this.lastTick) {
      this.salvoCounter++;
      this.lastOwner = rec.ownerId;
      this.lastWeapon = rec.weaponId;
      this.lastTick = rec.birthTick;
    }
    info.salvo = this.salvoCounter;
    info.idx = this.liveCount;
    this.live[this.liveCount++] = info;
    this.byId.set(projId, info);
    this.fresh[this.freshCount++] = info;
  }

  onEnd(projId: string, tick: number, x: number, y: number, blastRadius: number): void {
    const info = this.byId.get(projId);
    if (!info) return;
    info.endTick = tick;
    info.endX = x;
    info.endY = y;
    info.endR = blastRadius;
    this.retire(info, false);
  }

  onExpire(projId: string): void {
    const info = this.byId.get(projId);
    if (info) this.retire(info, true);
  }

  private retire(info: ShellInfo, silent: boolean): void {
    info.ended = true;
    info.silent = silent;
    this.byId.delete(info.id);
    // Swap-remove from the live list.
    const last = this.live[--this.liveCount]!;
    this.live[info.idx] = last;
    last.idx = info.idx;
    this.live[this.liveCount] = undefined as unknown as ShellInfo;
    info.idx = -1;
    this.ended[this.endedCount++] = info;
  }

  // ── Viewers ─────────────────────────────────────────────────────────────

  private slotOf(sessionId: string): number {
    let s = this.slots.get(sessionId);
    if (s !== undefined) return s;
    s = this.freeSlots.pop() ?? (this.nextSlot < SHELL_MAX_VIEWERS ? this.nextSlot++ : -1);
    if (s < 0) return -1;
    this.slots.set(sessionId, s);
    this.keyCursor[s] = 0;
    return s;
  }

  /** A viewer left: free its slot and forget what it was sent. */
  forgetViewer(sessionId: string): void {
    const s = this.slots.get(sessionId);
    if (s === undefined) return;
    this.slots.delete(sessionId);
    for (let i = 0; i < this.liveCount; i++) {
      const info = this.live[i]!;
      info.sent[s] = 0;
      info.keyTick[s] = 0;
    }
    this.freeSlots.push(s);
  }

  /** §3: does this viewer get this shell, judged from tick `now`? */
  private eligible(info: ShellInfo, v: ShellViewer, now: number): boolean {
    if (info.owner === v.playerId) return true;
    if (info.g !== undefined && info.g === v.playerId) return true;
    const end = shellPathEndTick(info.t, info.n);
    if (now < end) {
      const from = now > info.t ? now : info.t;
      shellPoseAt(info.x, info.y, info.vx, info.vy, info.t, from, this.pose);
      shellPoseAt(info.x, info.y, info.vx, info.vy, info.t, end, this.poseEnd);
      if (shellSegmentInView(this.pose.x, this.pose.y, this.poseEnd.x, this.poseEnd.y, v.x, v.y, v.half)) return true;
    }
    return this.deps.ownerWideInView(info.owner, v.sessionId);
  }

  // ── Flush (once per room update) ────────────────────────────────────────

  /** Send this tick's salvos and ends, and run the 1 Hz re-test. */
  flush(): void {
    const tick = this.deps.serverTick();
    const retest = this.liveCount > 0 && tick % SHELL_RETEST_TICKS === 0;
    this.sentSalvos = 0;
    this.sentEnds = 0;
    if (this.freshCount === 0 && this.endedCount === 0 && !retest) return;
    this.flushTick = tick;
    this.flushRetest = retest;
    this.deps.forEachViewer(this.visitViewer);
    for (let i = 0; i < this.freshCount; i++) this.fresh[i] = undefined as unknown as ShellInfo;
    this.freshCount = 0;
    for (let i = 0; i < this.endedCount; i++) {
      const info = this.ended[i]!;
      this.ended[i] = undefined as unknown as ShellInfo;
      this.pool.push(info);
    }
    this.endedCount = 0;
  }

  private flushViewer(v: ShellViewer): void {
    const slot = this.slotOf(v.sessionId);
    if (slot < 0) return;
    const now = this.flushTick;
    // 1. New salvos (judged at fire time). An ended-this-tick shell is still
    //    sent, so its shell_end below has something to end.
    this.sendGroup(v, slot, this.fresh, this.freshCount, true, now);
    // 2. The re-test: live shells this viewer hasn't been sent.
    if (this.flushRetest) this.sendGroup(v, slot, this.live, this.liveCount, false, now);
    // 3. Ends of shells this viewer has.
    if (this.endedCount > 0) {
      const e = this.endMsg.e;
      let k = 0;
      for (let i = 0; i < this.endedCount; i++) {
        const info = this.ended[i]!;
        if (info.silent || info.sent[slot] !== 1) continue;
        let tup = this.endTuples[k];
        if (!tup) { tup = ['', 0, 0, 0, 0]; this.endTuples[k] = tup; }
        tup[0] = info.id; tup[1] = info.endTick; tup[2] = info.endX; tup[3] = info.endY; tup[4] = info.endR;
        e[k++] = tup;
        if (k === END_MAX) { e.length = k; this.deps.send(v.sessionId, 'shell_end', this.endMsg); this.sentEnds++; k = 0; }
      }
      if (k > 0) { e.length = k; this.deps.send(v.sessionId, 'shell_end', this.endMsg); this.sentEnds++; }
    }
  }

  /** Send the eligible, not-yet-sent shells of `list` as salvo messages,
   *  splitting where the salvo id changes. */
  private sendGroup(v: ShellViewer, slot: number, list: ShellInfo[], count: number, atFire: boolean, now: number): void {
    let msg: MutSalvo | null = null;
    let k = 0;
    for (let i = 0; i < count; i++) {
      const info = list[i]!;
      if (info.sent[slot] === 1) continue;
      if (!this.eligible(info, v, atFire ? info.t : now)) continue;
      if (msg !== null && (msg.s !== info.salvo || k === SALVO_MAX_SHELLS)) {
        this.sendSalvo(v.sessionId, msg, k);
        msg = null;
        k = 0;
      }
      if (msg === null) {
        msg = info.g !== undefined ? this.salvoMsgG : this.salvoMsg;
        msg.s = info.salvo;
        msg.o = info.ownerWire;
        msg.w = info.w;
        msg.t = info.t;
        msg.n = info.n;
        if (info.g !== undefined) msg.g = info.g;
      }
      let tup = this.shTuples[k];
      if (!tup) { tup = ['', 0, 0, 0, 0]; this.shTuples[k] = tup; }
      tup[0] = info.id; tup[1] = info.x; tup[2] = info.y; tup[3] = info.vx; tup[4] = info.vy;
      msg.sh[k++] = tup;
      info.sent[slot] = 1;
      info.keyTick[slot] = now;
    }
    if (msg !== null && k > 0) this.sendSalvo(v.sessionId, msg, k);
  }

  private sendSalvo(sessionId: string, msg: MutSalvo, k: number): void {
    // Both pooled messages share the tuple pool; `sh` is per message object.
    msg.sh.length = k;
    this.deps.send(sessionId, 'shell_salvo', msg);
    this.sentSalvos++;
  }

  // ── Keyframe (§5) ───────────────────────────────────────────────────────

  /**
   * Fill `out` with up to `SHELL_KEY_PER_SNAPSHOT` keyframe records for this
   * viewer: shells it was sent whose last salvo/keyframe is at least
   * `SHELL_KEY_PERIOD_TICKS` old, round-robin from a per-viewer cursor.
   * Returns the count; `out` keeps its slot objects (pooled).
   */
  keyframeFor(sessionId: string, out: ShellKeyRecord[]): number {
    const slot = this.slots.get(sessionId);
    if (slot === undefined || this.liveCount === 0) return 0;
    const now = this.deps.serverTick();
    let k = 0;
    const n = this.liveCount;
    let i = this.keyCursor[slot]! % n;
    for (let seen = 0; seen < n && k < SHELL_KEY_PER_SNAPSHOT; seen++, i = (i + 1) % n) {
      const info = this.live[i]!;
      if (info.sent[slot] !== 1 || now - info.keyTick[slot]! < SHELL_KEY_PERIOD_TICKS) continue;
      let rec = out[k];
      if (!rec) { rec = ['', 0, '', 'naval_s', 0, 1, 0, 0, 0, 0]; out[k] = rec; }
      rec[0] = info.id; rec[1] = info.salvo; rec[2] = info.ownerWire; rec[3] = info.w;
      rec[4] = info.t; rec[5] = info.n; rec[6] = info.x; rec[7] = info.y; rec[8] = info.vx; rec[9] = info.vy;
      info.keyTick[slot] = now;
      k++;
    }
    this.keyCursor[slot] = i;
    return k;
  }

  // ── Join (§5) ───────────────────────────────────────────────────────────

  /**
   * The welcome's `shellsInFlight` for a joining viewer: every live shell it
   * should see, grouped by salvo, marked sent. Allocates (join, not the tick).
   * Undefined when there is nothing to send.
   */
  joinPayload(v: ShellViewer): ShellSalvo[] | undefined {
    const slot = this.slotOf(v.sessionId);
    if (slot < 0 || this.liveCount === 0) return undefined;
    const now = this.deps.serverTick();
    const out: ShellSalvo[] = [];
    let cur: ShellSalvo | null = null;
    for (let i = 0; i < this.liveCount; i++) {
      const info = this.live[i]!;
      if (info.sent[slot] === 1 || !this.eligible(info, v, now)) continue;
      if (cur === null || cur.s !== info.salvo || cur.sh.length === SALVO_MAX_SHELLS) {
        cur = { type: 'shell_salvo', s: info.salvo, o: info.ownerWire, w: info.w, t: info.t, n: info.n, sh: [] };
        if (info.g !== undefined) cur.g = info.g;
        out.push(cur);
      }
      cur.sh.push([info.id, info.x, info.y, info.vx, info.vy]);
      info.sent[slot] = 1;
      info.keyTick[slot] = now;
    }
    return out.length > 0 ? out : undefined;
  }
}
