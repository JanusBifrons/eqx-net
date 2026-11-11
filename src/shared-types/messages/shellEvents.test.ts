/** Shells as events: wire schemas, the switch and the welcome fields (§2, §7). */
import { describe, expect, it } from 'vitest';
import {
  ShellEndSchema, ShellKeyRecordSchema, ShellSalvoSchema, resolveShellEvents,
} from './shellEvents.js';
import { WelcomeSchema } from './snapshotMessages.js';

const salvo = {
  type: 'shell_salvo', s: 3, o: 'swarm-12', w: 'naval_xl', t: 9000, n: 2118,
  sh: [['proj-1', 10.1, -4.2, 1900.25, 0.5]],
};

describe('shell event schemas', () => {
  it('accepts a salvo, an end and a keyframe record', () => {
    expect(ShellSalvoSchema.safeParse(salvo).success).toBe(true);
    expect(ShellSalvoSchema.safeParse({ ...salvo, g: 'pilot-1' }).success).toBe(true);
    expect(ShellEndSchema.safeParse({ type: 'shell_end', e: [['proj-1', 9010, 1, 2, 0]] }).success).toBe(true);
    expect(ShellKeyRecordSchema.safeParse(['proj-1', 3, 'swarm-12', 'naval_xl', 9000, 2118, 1, 2, 3, 4]).success).toBe(true);
  });

  it('drops malformed packets', () => {
    expect(ShellSalvoSchema.safeParse({ ...salvo, w: 'laser' }).success).toBe(false);
    expect(ShellSalvoSchema.safeParse({ ...salvo, sh: [] }).success).toBe(false);
    expect(ShellSalvoSchema.safeParse({ ...salvo, extra: 1 }).success).toBe(false);
    expect(ShellSalvoSchema.safeParse({ ...salvo, n: 0 }).success).toBe(false);
    expect(ShellEndSchema.safeParse({ type: 'shell_end', e: [['proj-1', 1, 2, 3, -1]] }).success).toBe(false);
    expect(ShellEndSchema.safeParse({ type: 'shell_end', e: [] }).success).toBe(false);
  });

  it('the switch reads only 1 / true', () => {
    expect(resolveShellEvents({ EQX_SHELL_EVENTS: '1' })).toBe(true);
    expect(resolveShellEvents({ EQX_SHELL_EVENTS: 'true' })).toBe(true);
    expect(resolveShellEvents({ EQX_SHELL_EVENTS: '0' })).toBe(false);
    expect(resolveShellEvents({})).toBe(false);
    expect(resolveShellEvents(undefined)).toBe(false);
  });

  it('the welcome carries shellEvents + shellsInFlight, and stays valid without them', () => {
    const base = { type: 'welcome', playerId: 'p', serverTick: 1, sectorKey: null, shipInstanceId: '' };
    expect(WelcomeSchema.safeParse(base).success).toBe(true);
    expect(WelcomeSchema.safeParse({ ...base, shellEvents: true, shellsInFlight: [salvo] }).success).toBe(true);
    expect(WelcomeSchema.safeParse({ ...base, shellEvents: false }).success).toBe(false);
  });
});
