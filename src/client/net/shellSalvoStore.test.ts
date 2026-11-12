import { describe, expect, it } from 'vitest';
import { ShellSalvoStore } from './shellSalvoStore';
import { syncProjectiles } from './SnapshotSyncHelpers';
import type { ShellSalvo } from '@shared-types/messages/shellEvents';
import type { ProjectileRenderState, RenderMirror } from '@core/contracts/IRenderer';
import { getWeapon } from '@core/combat/WeaponCatalogue';
import { shellPathEndTick } from '@core/combat/shellFlight';

const radiusOf = (w: 'naval_xl' | 'naval_l'): number => { const d = getWeapon(w); return d.mode === 'hitscan' ? -1 : d.radius; };
const XL_R = radiusOf('naval_xl');
const L_R = radiusOf('naval_l');

const salvo: ShellSalvo = {
  type: 'shell_salvo', s: 4, o: 'swarm-3', w: 'naval_xl', t: 1000, n: 120,
  sh: [['proj-1', 10, 20, 1800, 0], ['proj-2', 11, 25, 1800, 0]],
};

describe('ShellSalvoStore (shells as events, client ingest + drawing)', () => {
  it('records each shell of a salvo by its projectile id', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    expect(st.map.get('proj-1')).toMatchObject({ s: 4, t: 1000, n: 120, x0: 10, y0: 20, vx: 1800, vy: 0, o: 'swarm-3', w: 'naval_xl', wr: XL_R, endTick: -1 });
    expect(st.map.get('proj-2')?.y0).toBe(25);
  });

  it('a keyframe adopts unknown shells and leaves known ones alone', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    st.applyKeyframe([
      ['proj-1', 99, 'swarm-3', 'naval_xl', 5, 6, 0, 0, 0, 0],
      ['proj-3', 5, 'swarm-8', 'naval_l', 1010, 90, -1, -2, 3, 4],
    ]);
    expect(st.map.get('proj-1')?.s).toBe(4);
    expect(st.map.get('proj-3')).toMatchObject({ s: 5, t: 1010, n: 90, x0: -1, y0: -2, vx: 3, vy: 4, o: 'swarm-8', w: 'naval_l', wr: L_R });
  });

  it('place() draws each shell on its closed-form path at the display tick, and not before it was fired', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    const proj = new Map<string, ProjectileRenderState>();
    const bursts: number[] = [];
    st.place(proj, 999.5, bursts);
    expect(proj.size).toBe(0); // fired at 1000: not on the display clock yet
    st.place(proj, 1030, bursts);
    expect(proj.get('proj-1')).toMatchObject({ x: 10 + 1800 * 0.5, y: 20, vx: 1800, ownerId: 'swarm-3', weaponId: 'naval_xl', event: true });
    st.place(proj, 1030.5, bursts);
    expect(proj.get('proj-1')!.x).toBeCloseTo(10 + 1800 * (30.5 / 60), 9);
    expect(bursts).toEqual([]);
  });

  it('a hit flies on screen until the display reaches its tick, then bursts there and is removed', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    const proj = new Map<string, ProjectileRenderState>();
    const bursts: number[] = [];
    st.applyEnd({ type: 'shell_end', e: [['proj-1', 1050, 1510, 20, 0]] }, bursts);
    expect(bursts).toEqual([]); // known shell: not yet
    st.place(proj, 1049.9, bursts);
    expect(proj.get('proj-1')?.event).toBe(true);
    expect(bursts).toEqual([]);
    st.place(proj, 1050, bursts);
    expect(bursts).toEqual([1510, 20, XL_R]);
    expect(proj.has('proj-1')).toBe(false);
    expect(st.map.has('proj-1')).toBe(false);
    expect(proj.has('proj-2')).toBe(true);
  });

  it('an end for a shell never seen bursts at once at the default size', () => {
    const st = new ShellSalvoStore();
    const bursts: number[] = [];
    st.applyEnd({ type: 'shell_end', e: [['proj-x', 1, 7, 8, 0]] }, bursts);
    expect(bursts).toEqual([7, 8, 3]);
  });

  it('a miss is removed silently once the display passes the end of its path', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    const proj = new Map<string, ProjectileRenderState>();
    const bursts: number[] = [];
    const end = shellPathEndTick(1000, 120);
    st.place(proj, end, bursts);
    expect(proj.has('proj-1')).toBe(true); // still sweeping its last step
    st.place(proj, end + 0.5, bursts);
    expect(proj.has('proj-1')).toBe(false);
    expect(bursts).toEqual([]);
  });

  it('snapshot sync leaves event shells alone: no overwrite, no delete', () => {
    const st = new ShellSalvoStore();
    st.applySalvo(salvo);
    const mirror = { projectiles: new Map<string, ProjectileRenderState>() } as unknown as RenderMirror;
    st.place(mirror.projectiles!, 1030, []);
    const before = { ...mirror.projectiles!.get('proj-1')! };
    // The per-tick copy of the same shell, a snapshot later and further along.
    syncProjectiles(mirror, [{ id: 'proj-1', x: 9999, y: 9999, vx: 1, vy: 1, ownerId: 'x', weaponId: 'naval_xl' }], new Set());
    expect(mirror.projectiles!.get('proj-1')).toEqual(before);
    syncProjectiles(mirror, [], new Set()); // the per-tick copy left interest
    expect(mirror.projectiles!.get('proj-2')?.event).toBe(true);
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
