/**
 * Helm orders belong to Command, never Fly (owner, 2026-11-21): in Fly the
 * pilot flies by hand only, so a tap on empty space sets no course and a
 * course still in force when the pilot switches to Fly stops driving the
 * ship. Command is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { HelmModeGate, helmOrdersAllowed } from './helmModeGate.js';

function fakeClient(): { setHelmCourse: ReturnType<typeof vi.fn>; clearHelm: ReturnType<typeof vi.fn> } {
  return { setHelmCourse: vi.fn(), clearHelm: vi.fn() };
}
const FLY = { pilotMode: 'pilot', buildMode: false } as const;
const COMMAND = { pilotMode: 'spectator', buildMode: false } as const;
const BUILD = { pilotMode: 'spectator', buildMode: true } as const;

describe('helmOrdersAllowed', () => {
  it('is Command only: never Fly, never Build', () => {
    expect(helmOrdersAllowed(COMMAND)).toBe(true);
    expect(helmOrdersAllowed(FLY)).toBe(false);
    expect(helmOrdersAllowed(BUILD)).toBe(false);
  });
});

describe('HelmModeGate', () => {
  it('a tap in Fly sets no course', () => {
    const gate = new HelmModeGate();
    const c = fakeClient();
    gate.frame(c, FLY, { helmCourseSeq: 0, helmCourseX: 0, helmCourseY: 0 });
    gate.frame(c, FLY, { helmCourseSeq: 1, helmCourseX: 100, helmCourseY: 200 });
    expect(c.setHelmCourse).not.toHaveBeenCalled();
  });

  it('a tap in Command sets the course, once per tap', () => {
    const gate = new HelmModeGate();
    const c = fakeClient();
    gate.frame(c, COMMAND, { helmCourseSeq: 1, helmCourseX: 100, helmCourseY: 200 });
    gate.frame(c, COMMAND, { helmCourseSeq: 1, helmCourseX: 100, helmCourseY: 200 });
    expect(c.setHelmCourse).toHaveBeenCalledTimes(1);
    expect(c.setHelmCourse).toHaveBeenCalledWith(100, 200);
  });

  it('a Fly tap is not replayed when the pilot later switches to Command', () => {
    const gate = new HelmModeGate();
    const c = fakeClient();
    gate.frame(c, FLY, { helmCourseSeq: 3, helmCourseX: 1, helmCourseY: 2 });
    gate.frame(c, COMMAND, { helmCourseSeq: 3, helmCourseX: 1, helmCourseY: 2 });
    expect(c.setHelmCourse).not.toHaveBeenCalled();
  });

  it('switching to Fly drops the course: manual takes over', () => {
    const gate = new HelmModeGate();
    const c = fakeClient();
    const fb = { helmCourseSeq: 0, helmCourseX: 0, helmCourseY: 0 };
    gate.frame(c, COMMAND, fb);
    expect(c.clearHelm).not.toHaveBeenCalled();
    gate.frame(c, FLY, fb);
    expect(c.clearHelm).toHaveBeenCalledTimes(1);
    gate.frame(c, FLY, fb); // once, on the switch
    expect(c.clearHelm).toHaveBeenCalledTimes(1);
    gate.frame(c, BUILD, fb);
    gate.frame(c, FLY, fb);
    expect(c.clearHelm).toHaveBeenCalledTimes(2);
  });

  it('switching back to Command clears nothing', () => {
    const gate = new HelmModeGate();
    const c = fakeClient();
    const fb = { helmCourseSeq: 0, helmCourseX: 0, helmCourseY: 0 };
    gate.frame(c, FLY, fb);
    gate.frame(c, COMMAND, fb);
    expect(c.clearHelm).not.toHaveBeenCalled();
  });
});
