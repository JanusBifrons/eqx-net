import { describe, expect, it } from 'vitest';
import { ShellSalvoStore } from './shellSalvoStore';
import type { ShellSalvo } from '@shared-types/messages/shellEvents';

const salvo: ShellSalvo = {
  type: 'shell_salvo', s: 4, o: 'swarm-3', w: 'naval_xl', t: 1000, n: 120,
  sh: [['proj-1', 10, 20, 1900, 0], ['proj-2', 11, 25, 1900, 0]],
};

describe('ShellSalvoStore (shells as events, client ingest)', () => {
  it('records each shell of a salvo by its projectile id', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    expect(st.map.get('proj-1')).toEqual({ s: 4, t: 1000, n: 120, x0: 10, y0: 20 });
    expect(st.map.get('proj-2')?.y0).toBe(25);
  });

  it('a keyframe adopts unknown shells and leaves known ones alone', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    st.applyKeyframe([
      ['proj-1', 99, 'swarm-3', 'naval_xl', 5, 6, 0, 0, 0, 0],
      ['proj-3', 5, 'swarm-3', 'naval_l', 1010, 90, -1, -2, 3, 4],
    ]);
    expect(st.map.get('proj-1')?.s).toBe(4);
    expect(st.map.get('proj-3')).toEqual({ s: 5, t: 1010, n: 90, x0: -1, y0: -2 });
  });

  it('shell_end drops a shell; a miss is swept after the end of its path, not before', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    st.applyEnd({ type: 'shell_end', e: [['proj-1', 1050, 0, 0, 0]] });
    expect(st.map.has('proj-1')).toBe(false);
    st.sweep(1000 + 120 + 1); // shellPathEndTick: still flying its last step
    expect(st.map.has('proj-2')).toBe(true);
    st.sweep(1000 + 120 + 2);
    expect(st.map.has('proj-2')).toBe(false);
  });

  it('reuses records once warm (no allocation per salvo)', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    const old = [st.map.get('proj-1'), st.map.get('proj-2')];
    st.clear();
    st.applySalvo({ ...salvo, sh: [['proj-9', 0, 0, 0, 0]] });
    expect(old).toContain(st.map.get('proj-9'));
    expect(st.map.size).toBe(1);
  });
});
