import { describe, it, expect } from 'vitest';
import { defaultFilterVert } from 'pixi.js';
import { FXAA_FRAGMENT } from './FxaaFilter';

/**
 * The FXAA pass must link against Pixi's default filter vertex shader. A
 * uniform both stages declare with different precision fails the link (the
 * vertex stage defaults to highp, the fragment stage to mediump): Pixi logs
 * "Could not initialize shader" and the filtered world draws nothing (found
 * by the antialias probe: the whole world vanished under ?aa=fxaa).
 */
const UNIFORM = /uniform\s+(?:(highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*;/g;

function uniforms(src: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const m of src.matchAll(UNIFORM)) out.set(m[2]!, m[1]);
  return out;
}

describe('FxaaFilter shader', () => {
  it('declares every uniform it shares with the vertex shader as highp', () => {
    const vert = uniforms(defaultFilterVert);
    const frag = uniforms(FXAA_FRAGMENT);
    const shared = [...frag.keys()].filter((n) => vert.has(n));
    expect(shared).toContain('uInputSize');
    for (const name of shared) expect(frag.get(name), name).toBe('highp');
  });
});
