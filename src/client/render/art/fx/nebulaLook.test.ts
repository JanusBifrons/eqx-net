import { describe, it, expect } from 'vitest';
import { bakeNebLook, hueTint, nebulaStyle, NEB_LOOK_PRESETS, parseNebLook, resolveNebLook } from './nebulaLook.js';

describe('dense-nebula look R&D (?neblook=)', () => {
  it('reads the flag: preset and seed, absent = off', () => {
    expect(resolveNebLook('?room=sector')).toBeUndefined();
    expect(resolveNebLook('?neblook=storm')).toBe('storm:1');
    expect(resolveNebLook('?a=1&neblook=rainbow&nebseed=42')).toBe('rainbow:42');
    expect(resolveNebLook('?neblook=plaid')).toBeUndefined();
    expect(parseNebLook('plaid:1')).toBeNull();
    expect(parseNebLook('fog:3')?.preset).toBe('fog');
  });

  it('a style is deterministic per seed and the seed changes the colours', () => {
    for (const p of NEB_LOOK_PRESETS) {
      expect(nebulaStyle(p, 5)).toEqual(nebulaStyle(p, 5));
      expect(nebulaStyle(p, 5).hueA).not.toBe(nebulaStyle(p, 6).hueA);
    }
  });

  it('the presets sit at different corners: one colour, rainbow, storm', () => {
    const fog = nebulaStyle('fog', 1), rb = nebulaStyle('rainbow', 1), storm = nebulaStyle('storm', 1);
    expect(fog.rainbow).toBeLessThan(0.1);
    expect(rb.rainbow).toBeGreaterThan(0.75);
    expect(storm.lightning).toBeGreaterThan(0);
    expect(fog.lightning).toBe(0);
    expect(storm.dust).toBeGreaterThan(fog.dust);
    expect(fog.thickness).toBeGreaterThan(rb.thickness);
  });

  it('bakes layer, puff and dust textures with some cloud and some clear', () => {
    for (const part of ['L0', 'P1', 'D']) {
      const img = bakeNebLook(`storm:2.${part}`);
      let lit = 0, clear = 0;
      for (let i = 3; i < img.data.length; i += 4) { if (img.data[i]! > 40) lit++; else if (img.data[i]! < 8) clear++; }
      const n = img.w * img.h;
      expect(lit / n, part).toBeGreaterThan(0.05);
      expect(clear / n, part).toBeGreaterThan(0.02);
    }
  });

  it('hueTint: red at 0, full saturation', () => {
    expect(hueTint(0, 1)).toBe(0xff0000);
    expect(hueTint(1 / 3, 1)).toBe(0x00ff00);
  });
});
