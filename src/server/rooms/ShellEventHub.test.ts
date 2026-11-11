/**
 * Shells as events, slice 1 (docs/architecture/shell-events.md §3, §5): who
 * receives a salvo, the 1 Hz re-test as a viewer moves, `shell_end` routing,
 * the keyframe rotation and the join backlog.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ShellEventHub, type ShellViewer } from './ShellEventHub.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';
import {
  ShellEndSchema, ShellSalvoSchema, ShellKeyRecordSchema,
  SHELL_KEY_PER_SNAPSHOT, SHELL_KEY_PERIOD_TICKS, SHELL_RETEST_TICKS,
  type ShellEnd, type ShellKeyRecord, type ShellSalvo,
} from '../../shared-types/messages/shellEvents.js';

interface Sent { to: string; type: string; msg: ShellSalvo | ShellEnd }

const HALF = 6_400; // a fighter's view half-extent
const SPEED = 600; // u/s along +x
const MAX_TICKS = 600; // 10 s ⇒ 6,000 u of flight

function rec(ownerId: string, tick: number, x = 0, y = 0, vx = SPEED, vy = 0): ProjectileRecord {
  return { x, y, vx, vy, ownerId, birthTick: tick, damage: 100, radius: 4, maxTicks: MAX_TICKS, weaponId: 'naval_xl', ox: x, oy: y };
}

describe('ShellEventHub', () => {
  let tick: number;
  let viewers: ShellViewer[];
  let sent: Sent[];
  let wide: Set<string>;
  let hub: ShellEventHub;

  beforeEach(() => {
    tick = 1_000;
    viewers = [];
    sent = [];
    wide = new Set();
    hub = new ShellEventHub({
      serverTick: () => tick,
      wireOwnerId: (o) => (o.startsWith('drone-') ? `swarm-${o.slice(6)}` : o),
      ownerWideInView: (o, s) => wide.has(`${o}|${s}`),
      forEachViewer: (fn) => { for (const v of viewers) fn(v); },
      // Deep-copy: the hub reuses its message objects (Colyseus encodes in send()).
      send: (to, type, msg) => { sent.push({ to, type, msg: JSON.parse(JSON.stringify(msg)) as ShellSalvo }); },
    });
  });

  const viewer = (sessionId: string, x: number, y: number, playerId = `p-${sessionId}`): ShellViewer =>
    ({ sessionId, playerId, x, y, half: HALF });
  const salvosTo = (s: string): ShellSalvo[] => sent.filter((m) => m.to === s && m.type === 'shell_salvo').map((m) => m.msg as ShellSalvo);
  const endsTo = (s: string): ShellEnd[] => sent.filter((m) => m.to === s && m.type === 'shell_end').map((m) => m.msg as ShellEnd);

  it('sends one valid salvo per firer per gun per tick, to a viewer whose view the path crosses', () => {
    viewers.push(viewer('a', 3_000, 0));
    hub.onSpawn('proj-1', rec('drone-7', tick, 0, 0));
    hub.onSpawn('proj-2', rec('drone-7', tick, 0, 10));
    hub.onSpawn('proj-3', rec('drone-8', tick, 0, 20));
    hub.flush();
    const s = salvosTo('a');
    expect(s).toHaveLength(2);
    for (const m of s) expect(ShellSalvoSchema.safeParse(m).success).toBe(true);
    expect(s[0]!.o).toBe('swarm-7');
    expect(s[0]!.sh.map((t) => t[0])).toEqual(['proj-1', 'proj-2']);
    expect(s[1]!.sh.map((t) => t[0])).toEqual(['proj-3']);
    expect(s[0]!.s).not.toBe(s[1]!.s);
    expect(s[0]!.t).toBe(tick);
    expect(s[0]!.n).toBe(MAX_TICKS);
  });

  it('a path that crosses the view with both ends outside it is sent', () => {
    // Shell from x = −10,000 to +10,000 (speed 2,000 u/s × 10 s), view at the origin.
    viewers.push(viewer('a', 0, 0));
    hub.onSpawn('proj-1', rec('drone-1', tick, -10_000, 0, 2_000, 0));
    hub.flush();
    expect(salvosTo('a')).toHaveLength(1);
  });

  it('a far viewer gets nothing; the firer and a wide-owner viewer do', () => {
    viewers.push(viewer('far', 0, 50_000), viewer('firer', 0, 50_000, 'pilot-1'), viewer('wide', 0, 90_000));
    wide.add('drone-2|wide');
    hub.onSpawn('proj-1', rec('pilot-1', tick));
    hub.onSpawn('proj-2', rec('drone-2', tick));
    hub.flush();
    expect(salvosTo('far')).toHaveLength(0);
    expect(salvosTo('firer').flatMap((m) => m.sh.map((t) => t[0]))).toEqual(['proj-1']);
    expect(salvosTo('wide').flatMap((m) => m.sh.map((t) => t[0]))).toEqual(['proj-2']);
  });

  it('re-tests unsent shells at 1 Hz against the viewer\'s current pose', () => {
    const v = viewer('a', 0, 50_000);
    viewers.push(v);
    tick = 1_001;
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.flush();
    expect(salvosTo('a')).toHaveLength(0);
    // The viewer flies over to the shell's remaining path.
    v.y = 0;
    v.x = 4_000;
    tick = Math.ceil(tick / SHELL_RETEST_TICKS) * SHELL_RETEST_TICKS;
    hub.flush();
    const s = salvosTo('a');
    expect(s).toHaveLength(1);
    expect(s[0]!.t).toBe(1_001); // the original fire tick, so the client can place it
    // Sent once only.
    tick += SHELL_RETEST_TICKS;
    hub.flush();
    expect(salvosTo('a')).toHaveLength(1);
  });

  it('a shell whose path already ended is not sent by the re-test', () => {
    const v = viewer('a', 0, 50_000);
    viewers.push(v);
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.flush();
    v.y = 0; v.x = 1_000; // on the path, but only behind the shell now
    tick += MAX_TICKS + 2; // past shellPathEndTick (the shell would be gone anyway)
    tick = Math.ceil(tick / SHELL_RETEST_TICKS) * SHELL_RETEST_TICKS;
    hub.flush();
    expect(salvosTo('a')).toHaveLength(0);
  });

  it('shell_end goes only to viewers that were sent the shell; a miss sends nothing', () => {
    viewers.push(viewer('near', 3_000, 0), viewer('far', 0, 50_000));
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.onSpawn('proj-2', rec('drone-1', tick, 0, 5));
    hub.flush();
    tick += 120;
    hub.onEnd('proj-1', tick, 1_200, 0, 0);
    hub.onExpire('proj-2');
    hub.flush();
    const e = endsTo('near');
    expect(e).toHaveLength(1);
    expect(ShellEndSchema.safeParse(e[0]).success).toBe(true);
    expect(e[0]!.e).toEqual([['proj-1', tick, 1_200, 0, 0]]);
    expect(endsTo('far')).toHaveLength(0);
    expect(hub.size()).toBe(0);
  });

  it('a shell fired and ended before one flush is still sent, then ended', () => {
    viewers.push(viewer('a', 3_000, 0));
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.onEnd('proj-1', tick, 10, 0, 50);
    hub.flush();
    expect(sent.map((m) => m.type)).toEqual(['shell_salvo', 'shell_end']);
  });

  it('keyframe: re-sends each sent shell about every 2 s, at most 8 per snapshot, round-robin', () => {
    viewers.push(viewer('a', 3_000, 0));
    for (let i = 0; i < 12; i++) hub.onSpawn(`proj-${i}`, rec('drone-1', tick, 0, i));
    hub.flush();
    const out: ShellKeyRecord[] = [];
    expect(hub.keyframeFor('a', out)).toBe(0); // just sent
    tick += SHELL_KEY_PERIOD_TICKS;
    const n1 = hub.keyframeFor('a', out);
    expect(n1).toBe(SHELL_KEY_PER_SNAPSHOT);
    const first = out.slice(0, n1).map((r) => r[0]);
    for (const r of out.slice(0, n1)) expect(ShellKeyRecordSchema.safeParse(r).success).toBe(true);
    const n2 = hub.keyframeFor('a', out);
    expect(n2).toBe(4);
    const second = out.slice(0, n2).map((r) => r[0]);
    expect(new Set([...first, ...second]).size).toBe(12);
    expect(hub.keyframeFor('a', out)).toBe(0); // all re-sent; next turn in 2 s
    expect(hub.keyframeFor('nobody', out)).toBe(0);
  });

  it('join payload: live shells the joiner should see, grouped by salvo, then not re-sent', () => {
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.onSpawn('proj-2', rec('drone-1', tick, 0, 5));
    hub.flush(); // no viewers yet
    tick += 30;
    const j = hub.joinPayload(viewer('late', 4_000, 0));
    expect(j).toHaveLength(1);
    expect(ShellSalvoSchema.safeParse(j![0]).success).toBe(true);
    expect(j![0]!.sh).toHaveLength(2);
    viewers.push(viewer('late', 4_000, 0));
    tick = Math.ceil(tick / SHELL_RETEST_TICKS) * SHELL_RETEST_TICKS;
    hub.flush();
    expect(salvosTo('late')).toHaveLength(0);
    expect(hub.joinPayload(viewer('far', 0, 50_000))).toBeUndefined();
  });

  it('a leaving viewer\'s slot is reused cleanly by the next one', () => {
    viewers.push(viewer('a', 3_000, 0));
    hub.onSpawn('proj-1', rec('drone-1', tick));
    hub.flush();
    hub.forgetViewer('a');
    viewers.length = 0;
    viewers.push(viewer('b', 3_000, 0));
    tick = Math.ceil((tick + 1) / SHELL_RETEST_TICKS) * SHELL_RETEST_TICKS;
    hub.flush();
    expect(salvosTo('b')).toHaveLength(1); // b inherits a's slot, not a's "sent" marks
  });

  it('steady state with nothing to send never visits the viewers', () => {
    let visits = 0;
    const quiet = new ShellEventHub({
      serverTick: () => 7, wireOwnerId: (o) => o, ownerWideInView: () => false,
      forEachViewer: () => { visits++; }, send: () => {},
    });
    for (let i = 0; i < 100; i++) quiet.flush();
    expect(visits).toBe(0);
  });
});
