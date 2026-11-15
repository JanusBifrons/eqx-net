/**
 * A guard post that follows a ship (owner 2026-11-15, flagship escorts:
 * "Leash, but the zone follows the flagship"). `setGuardPost(x, y, r,
 * anchorId)` measures the guard zone round the anchor's CURRENT pose,
 * resolved each tick through `view.resolveEntityInto`; (x, y) is the
 * fallback while the anchor can't be resolved. The same leash as a fixed post
 * (`HostileDroneBehaviour.guardLeash.test.ts`), just a moving centre.
 *
 * Driven through the kinematic model of `applyShipInput` (player controls).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { AiController } from './AiController.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiEntityPoseOut, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const DT = 1 / 60;
const R = shipTuning(KIND).guardRadiusMin;

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

interface Sim {
  self: Body;
  view: Mut<AiWorldView>;
  tick: number;
  /** The anchor ship's live pose; `gone` ⇒ the resolver can't find it. */
  anchor: { x: number; y: number; gone: boolean };
}

function sim(at: { x: number; y: number }, anchorAt: { x: number; y: number }): Sim {
  const anchor = { x: anchorAt.x, y: anchorAt.y, gone: false };
  const resolveEntityInto = (id: string, out: AiEntityPoseOut): boolean => {
    if (id !== 'lead' || anchor.gone) return false;
    out.x = anchor.x; out.y = anchor.y; out.vx = 0; out.vy = 0; out.angle = 0; out.angvel = 0;
    return true;
  };
  return {
    self: { id: 'e', x: at.x, y: at.y, vx: 0, vy: 0, angle: 0, angvel: 0 },
    view: { players: [], tick: 200, dtSec: DT, resolveEntityInto },
    tick: 200,
    anchor,
  };
}

/** Run `seconds`; a hostile 'p' (if present) stays on the ledger. */
function run(b: HostileDroneBehaviour, s: Sim, seconds: number): { everTargeted: boolean } {
  let everTargeted = false;
  for (let i = 0; i < seconds * 60; i++) {
    s.view.tick = ++s.tick;
    if (s.view.players.length > 0) b.markHostile('p', s.tick);
    stepKinematic(s.self, KIND, b.tick(s.self, s.view));
    if (b.getTargetId() === 'p') everTargeted = true;
  }
  return { everTargeted };
}

describe('HostileDroneBehaviour — a guard post anchored to a ship', () => {
  it('the post moves with the anchor', () => {
    const b = new HostileDroneBehaviour(KIND);
    const s = sim({ x: 0, y: 0 }, { x: 0, y: 0 });
    b.setGuardPost(0, 0, 0, 'lead');
    s.anchor.x = 5 * R; s.anchor.y = -2 * R;
    run(b, s, 1 / 60);
    expect(b.getGuardPostX()).toBe(5 * R);
    expect(b.getGuardPostY()).toBe(-2 * R);
    s.anchor.x = -3 * R; s.anchor.y = 7 * R;
    run(b, s, 1 / 60);
    expect(b.getGuardPostX()).toBe(-3 * R);
    expect(b.getGuardPostY()).toBe(7 * R);
    expect(b.getGuardRadius()).toBe(R);
  });

  it('engages a hostile near the moved anchor that is outside the old fixed post (control: fixed post ignores it)', () => {
    // The anchor started at (0, 0) and has moved to (4R, 0); the escort is
    // with it, and a hostile sits half a radius beyond: 4.5R from the old post.
    const hostileAt = { id: 'p', x: 4 * R, y: 0.5 * R, vx: 0, vy: 0 };

    const fixed = new HostileDroneBehaviour(KIND);
    const fs = sim({ x: 4 * R, y: 0 }, { x: 4 * R, y: 0 });
    fs.view.players = [hostileAt];
    fixed.setGuardPost(0, 0, 0);
    expect(run(fixed, fs, 3).everTargeted, 'a fixed post engaged outside its radius').toBe(false);

    const esc = new HostileDroneBehaviour(KIND);
    const s = sim({ x: 4 * R, y: 0 }, { x: 0, y: 0 });
    s.view.players = [hostileAt];
    esc.setGuardPost(0, 0, 0, 'lead');
    s.anchor.x = 4 * R;
    expect(run(esc, s, 3).everTargeted, 'the escort ignored a hostile next to its moved anchor').toBe(true);
    expect(esc.getTargetId()).toBe('p');
  });

  it('an idle escort returns to the anchor\'s CURRENT spot', () => {
    const b = new HostileDroneBehaviour(KIND);
    const s = sim({ x: 0, y: 0 }, { x: 0, y: 0 });
    b.setGuardPost(0, 0, 0, 'lead');
    run(b, s, 1);
    s.anchor.x = 3 * R; s.anchor.y = R;
    run(b, s, 30);
    expect(Math.hypot(s.self.x - 3 * R, s.self.y - R), 'did not return to the anchor').toBeLessThan(R * 0.25);
  });

  it('holds the last known spot while the anchor cannot be resolved', () => {
    const b = new HostileDroneBehaviour(KIND);
    const s = sim({ x: 0, y: 0 }, { x: 2 * R, y: 0 });
    b.setGuardPost(0, 0, 0, 'lead');
    run(b, s, 1 / 60);
    s.anchor.gone = true;
    run(b, s, 1);
    expect(b.getGuardPostX()).toBe(2 * R);
    expect(b.getGuardPostY()).toBe(0);
    // It comes back: the post follows again.
    s.anchor.gone = false; s.anchor.x = -R;
    run(b, s, 1 / 60);
    expect(b.getGuardPostX()).toBe(-R);
  });

  it('a fixed post (no anchor) ignores the resolver', () => {
    const b = new HostileDroneBehaviour(KIND);
    const s = sim({ x: 0, y: 0 }, { x: 9 * R, y: 0 });
    b.setGuardPost(R, R, 0, 'lead');
    b.setGuardPost(R, R, 0);
    run(b, s, 1 / 60);
    expect(b.getGuardPostX()).toBe(R);
    expect(b.getGuardPostY()).toBe(R);
  });

  it('the post is cleared when the anchor leaves the AI controller (dies / despawns)', () => {
    const ctl = new AiController({ postIntent: () => {} });
    const esc = new HostileDroneBehaviour(KIND);
    const lead = new HostileDroneBehaviour(KIND);
    const other = new HostileDroneBehaviour(KIND);
    ctl.register('e', 0, esc);
    ctl.register('lead', 1, lead);
    ctl.register('x', 2, other);
    esc.setGuardPost(0, 0, 0, 'lead');
    ctl.unregister('x');
    expect(esc.getGuardRadius(), 'another ship leaving cleared the post').toBe(R);
    ctl.unregister('lead');
    expect(esc.getGuardRadius()).toBe(0);
    expect(esc.getGuardPostX()).toBeNull();
  });
});
