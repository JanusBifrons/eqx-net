import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { resolveCaptureDir } from './diagCaptureDir.js';

describe('resolveCaptureDir', () => {
  it('defaults to <cwd>/diag/captures', () => {
    expect(resolveCaptureDir({}, '/repo')).toBe(resolve('/repo', 'diag', 'captures'));
  });

  it('EQX_DIAG_DIR wins (the phone lane points it at run/captures)', () => {
    expect(resolveCaptureDir({ EQX_DIAG_DIR: '/lane/run/captures' }, '/repo')).toBe(resolve('/lane/run/captures'));
    expect(resolveCaptureDir({ EQX_DIAG_DIR: '' }, '/repo')).toBe(resolve('/repo', 'diag', 'captures'));
  });
});
