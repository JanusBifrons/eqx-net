/**
 * Naval shell impact bursts land where the shell was DRAWN.
 *
 * Reported (showcase review 2026-11-10, clip `capital-guns-fighter`, 12.33 s
 * and 16.3 s): "the 5" shells reach the fighter and its shield ring lights,
 * but the hit burst (white disc, shockwave rings, then a ~1.5 s fireball)
 * spawns about 380 px STRAIGHT ABOVE the fighter, at the same screen x, in
 * empty space". Cause: the renderer stored each shell's last position in Pixi
 * space (`-p.y`) and handed it to `FxExplosions.spawn`, which takes GAME space
 * and flips Y itself, so the burst sat at the shell's mirror about y = 0.
 *
 * Repro here: the shot's fighter spawns at game (1500, -1800); a 5" shell
 * flies in from the battleship and disappears there (hit). The burst must be
 * drawn on the same Pixi point the shell sprite was drawn on.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxExplosions } from './FxExplosions.js';
import { FxProjectiles } from './FxWeapons.js';
import { NavalShellBursts, type ShellView } from './navalShellBursts.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

describe('NavalShellBursts', () => {
  it('bursts a shell that hit on the Pixi point its sprite was drawn on (not its Y mirror)', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    const drawnBursts: Array<{ x: number; y: number }> = [];
    fx.onSpawn = (x, y): void => { drawnBursts.push({ x, y }); };
    const proj = new FxProjectiles(fakeArt());
    const bursts = new NavalShellBursts();
    const projectiles = new Map<string, ShellView>();

    // A 5" shell closing on the fighter at (1500, -1800), game space.
    let last = { x: 0, y: 0 };
    for (let i = 0; i <= 5; i++) {
      const shell = { x: 1300 + i * 40, y: -1700 - i * 20, vx: 2400, vy: -1200, weaponId: 'naval_s' };
      projectiles.set('s1', shell);
      proj.beginFrame();
      proj.draw('s1', 'shell', shell.x, shell.y, shell.vx, shell.vy, 1, 1);
      proj.endFrame();
      bursts.frame(projectiles, fx, 1000 + i * 16);
      last = { x: shell.x, y: shell.y };
    }
    expect(drawnBursts).toHaveLength(0);
    const sprite = proj.container.children.find((c) => c.visible)!;
    const drawnShell = { x: sprite.position.x, y: sprite.position.y };
    expect(drawnShell).toEqual({ x: last.x, y: -last.y }); // the sprite obeys pixiY = -gameY

    // The shell hits the fighter and is gone from the mirror.
    projectiles.delete('s1');
    bursts.frame(projectiles, fx, 1100);
    expect(drawnBursts).toHaveLength(1);
    expect(drawnBursts[0]!.x).toBeCloseTo(drawnShell.x, 6);
    expect(drawnBursts[0]!.y).toBeCloseTo(drawnShell.y, 6);

    // And the burst sprites themselves sit there.
    fx.tick(1150);
    const fire = fx.fireLayer.children.filter((c) => c.visible && c.position.x === drawnShell.x && c.position.y === drawnShell.y);
    expect(fire.length).toBeGreaterThan(0);
    expect(bursts.count()).toBe(0);
  });

  it('a shell that ran its full range fades without a burst', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    let n = 0;
    fx.onSpawn = (): void => { n++; };
    const bursts = new NavalShellBursts();
    const projectiles = new Map<string, ShellView>();
    projectiles.set('s2', { x: 0, y: -1000, weaponId: 'naval_s' });
    bursts.frame(projectiles, fx, 0);
    projectiles.set('s2', { x: 1e6, y: -1000, weaponId: 'naval_s' });
    bursts.frame(projectiles, fx, 16);
    projectiles.clear();
    bursts.frame(projectiles, fx, 32);
    expect(n).toBe(0);
  });

  it('ignores non-naval projectiles and beams', () => {
    const bursts = new NavalShellBursts();
    const projectiles = new Map<string, ShellView>([['a', { x: 0, y: 0, weaponId: 'laser' }], ['b', { x: 0, y: 0, weaponId: 'naval_s', beam: { toX: 1, toY: 0 } }]]);
    bursts.frame(projectiles, null, 0);
    expect(bursts.count()).toBe(0);
  });

  // Shells as events slice 2b (docs/architecture/shell-events.md §1, §4): the
  // FALSE EDGE BURST. A shell that leaves the viewer's interest mid-flight
  // vanishes from the snapshots exactly like one that hit something, so the
  // absence guess burst it in empty space. With events on (the welcome said
  // shellEvents), only a shell_end bursts a shell.
  it('events on: a shell that leaves the view at half travel does not burst; a shell_end bursts at the hit', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    const at: Array<{ x: number; y: number }> = [];
    fx.onSpawn = (x, y): void => { at.push({ x, y }); };
    const bursts = new NavalShellBursts();
    const projectiles = new Map<string, ShellView>();
    const ends: number[] = [];
    // A 16" shell crosses the view and leaves it at half its reach.
    for (let i = 0; i <= 10; i++) {
      projectiles.set('proj-7', { x: i * 300, y: 0, weaponId: 'naval_xl' });
      bursts.frame(projectiles, fx, i * 16, ends, true);
    }
    projectiles.delete('proj-7'); // out of interest: no more snapshots carry it
    bursts.frame(projectiles, fx, 200, ends, true);
    expect(at).toHaveLength(0);
    // Another shell is reported hit (shell_end): it bursts at the hit point.
    ends.push(4200, -50, 6);
    bursts.frame(projectiles, fx, 216, ends, true);
    expect(at).toHaveLength(1);
    expect(at[0]!.x).toBeCloseTo(4200, 6);
    expect(at[0]!.y).toBeCloseTo(50, 6); // FxExplosions draws in Pixi space (y flipped)
  });

  it('events off: unchanged (a shell gone early still bursts where it was last seen)', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    let n = 0;
    fx.onSpawn = (): void => { n++; };
    const bursts = new NavalShellBursts();
    const projectiles = new Map<string, ShellView>([['s', { x: 0, y: 0, weaponId: 'naval_xl' }]]);
    bursts.frame(projectiles, fx, 0);
    projectiles.set('s', { x: 300, y: 0, weaponId: 'naval_xl' });
    bursts.frame(projectiles, fx, 16);
    projectiles.clear();
    bursts.frame(projectiles, fx, 32);
    expect(n).toBe(1);
  });
});
