import { describe, it, expect } from 'vitest';
import { arcDegrees, formatReloadSeconds, structureGunLines, structureGunReloadMs } from './structureGunLines';
import { getStructureKind } from '@shared-types/structureKinds';

describe('structureGunLines', () => {
  it('formats reload seconds', () => {
    expect(formatReloadSeconds(30_000)).toBe('30 s');
    expect(formatReloadSeconds(4_000)).toBe('4 s');
    expect(formatReloadSeconds(2_500)).toBe('2.5 s');
    expect(formatReloadSeconds(120_000)).toBe('120 s');
  });

  it('reload mirrors the server: fireRateMs first, else cooldownTicks at 60 Hz', () => {
    expect(structureGunReloadMs({ fireRateMs: 30_000 }, 60)).toBe(30_000);
    expect(structureGunReloadMs({}, 1800)).toBe(30_000);
  });

  it('arc in degrees, null when all round', () => {
    const DEG = Math.PI / 180;
    expect(arcDegrees(-72 * DEG, 72 * DEG)).toBe(144);
    expect(arcDegrees(-Math.PI, Math.PI)).toBeNull();
  });

  it('16" barbette: twin guns, 30 s reload, 144° arc', () => {
    expect(structureGunLines(getStructureKind('coastal_barbette_16in'))).toEqual(['16" ×2 · reload 30 s · arc 144°']);
  });

  it('8" casemate: single gun, no ×1', () => {
    const [line] = structureGunLines(getStructureKind('coastal_casemate_8in'));
    expect(line).toMatch(/^8" · reload \d+(\.\d)? s · arc 120°$/);
  });

  it('5" DP mount trains all round', () => {
    expect(structureGunLines(getStructureKind('dp_mount_5in'))[0]).toMatch(/^5" ×2 · reload .* · all round$/);
  });

  it('non-naval structures get no lines', () => {
    expect(structureGunLines(getStructureKind('connector'))).toEqual([]);
    expect(structureGunLines(getStructureKind('aa_quad_40mm'))).toEqual([]);
  });
});
