/**
 * The cut field must give bit-identical rocks on the server (V8) and in every
 * browser (V8, SpiderMonkey, JavaScriptCore): Math.sin/cos/tan/atan2/pow/
 * hypot/exp/log and `**` are not specified bit-exactly across engines, so the
 * generator may not use them (macro-terrain plan v2, A1; the capital fracture
 * follows the same rule).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('cut field is arithmetic only', () => {
  it('src/core/terrain/fieldLayout.ts uses no engine-dependent maths', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/core/terrain/fieldLayout.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan|atan2|pow|hypot|exp|log|cbrt)\b/);
    expect(code).not.toMatch(/\*\*/);
  });
});
