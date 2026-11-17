/** Structure livery forge (structure restyle 1c): no livery = today's bake,
 *  byte for byte; a liveried capital stamps its sigil screen. */
import { describe, it, expect } from 'vitest';
import { forgeStructure, type Fields } from './fields.js';

const bytes = (f: Fields): Buffer[] => [f.albedo, f.height, f.emis, f.mat, f.key, f.cov].map((a) => Buffer.from(a.buffer));

describe('forgeStructure livery', () => {
  it('livery absent: byte-identical to the opts-free bake', () => {
    for (const id of ['capital', 'refinery', 'cargo_bay', 'freight_dock']) {
      const a = bytes(forgeStructure(id, { ppu: 0.5, seed: 1 }));
      const b = bytes(forgeStructure(id, { ppu: 0.5, seed: 1, livery: undefined }));
      a.forEach((x, i) => expect(x.equals(b[i]!), id).toBe(true));
    }
  });
  it('liveried capital: sigil screen stamped, paint differs', () => {
    const f = forgeStructure('capital', { ppu: 0.5, seed: 1, livery: { team: 0x3a7bff, sigil: 0xffd23a } });
    expect(f.sigils?.length).toBeGreaterThan(0);
    expect(Buffer.from(f.albedo.buffer).equals(Buffer.from(forgeStructure('capital', { ppu: 0.5, seed: 1 }).albedo.buffer))).toBe(false);
  });
});
