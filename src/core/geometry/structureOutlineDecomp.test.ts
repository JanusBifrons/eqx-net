/**
 * Stage 3 readiness: every structure outline (some concave) decomposes into
 * convex collider parts through the EXISTING `convexParts`, so the collider
 * flip of `structureHullPoints` needs no new decomposition code.
 */
import { describe, it, expect } from 'vitest';
import { STRUCTURE_KINDS_LIST, structureOutline } from '../../shared-types/structureKinds.js';
import { convexParts, signedArea } from './shipHullDecomp.js';

describe('structureOutline → convexParts', () => {
  it.each(STRUCTURE_KINDS_LIST.map((k) => k.id))('%s decomposes into convex parts', (id) => {
    const poly = structureOutline(id);
    const parts = convexParts(poly);
    expect(parts).not.toBeNull();
    const sum = parts!.reduce((acc, p) => acc + signedArea(p), 0);
    expect(sum).toBeCloseTo(signedArea(poly), 3);
  });
});
