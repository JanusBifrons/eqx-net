/** The loading screen's bake % slice: monotone within a join, capped below
 *  100 until the renderer says the art is ready, written only on change, and
 *  re-armed by every new join. */
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';
import { syncArtBake } from './artBakeUi.js';

const ui = () => useUIStore.getState();

beforeEach(() => {
  useUIStore.setState({ artBakePct: 0, artBakeReady: false });
});

describe('artBake slice', () => {
  it('rounds down, never goes backwards, and caps at 99 until ready', () => {
    ui().setArtBake(42.9, false);
    expect(ui().artBakePct).toBe(42);
    ui().setArtBake(20, false); // more hulls came into view: never backwards
    expect(ui().artBakePct).toBe(42);
    ui().setArtBake(100, false);
    expect(ui().artBakePct).toBe(99);
    ui().setArtBake(100, true);
    expect(ui().artBakePct).toBe(100);
    expect(ui().artBakeReady).toBe(true);
  });

  it('writes nothing when the value is unchanged', () => {
    ui().setArtBake(30, false);
    let writes = 0;
    const off = useUIStore.subscribe(() => { writes++; });
    ui().setArtBake(30.4, false);
    ui().setArtBake(10, false);
    expect(writes).toBe(0);
    ui().setArtBake(31, false);
    expect(writes).toBe(1);
    off();
  });

  it('syncArtBake turns the renderer counts into a share, and no art reads as done', () => {
    syncArtBake(ui(), { artReady: false, artBakeDone: 3, artBakeTotal: 4 });
    expect(ui().artBakePct).toBe(75);
    syncArtBake(ui(), { artReady: true, artBakeDone: 0, artBakeTotal: 0 });
    expect(ui().artBakePct).toBe(100);
    expect(ui().artBakeReady).toBe(true);
  });

  it('a new join re-arms the bake to zero', () => {
    ui().setArtBake(100, true);
    ui().rearmJoinReadiness();
    expect(ui().artBakePct).toBe(0);
    expect(ui().artBakeReady).toBe(false);
  });
});
