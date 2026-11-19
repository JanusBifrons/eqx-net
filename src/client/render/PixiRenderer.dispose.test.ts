/**
 * Teardown refs are built by a field initialiser, which runs before the
 * constructor body. A plain value captured there (`halo: this.halo`) froze as
 * `undefined`, and `dispose()` threw at `halo.destroy()`. Every ref the
 * constructor body or `init` assigns must be read live (a getter).
 */
import { describe, expect, it } from 'vitest';
import { PixiRenderer } from './PixiRenderer';

type TeardownView = { _teardown: { halo: unknown }; halo: unknown };

describe('PixiRenderer teardown refs', () => {
  it('hands dispose the halo the constructor built', () => {
    const r = new PixiRenderer() as unknown as TeardownView;
    expect(r.halo).toBeDefined();
    expect(r._teardown.halo).toBe(r.halo);
  });
});
