/**
 * Every Vite dev-proxy entry must target the configurable `SERVER_PORT`, never
 * a hard-coded 2567. The showcase pipeline runs an isolated server on another
 * port (EQX_SERVER_PORT); a hard-coded `/trade` target sent its takes to a
 * different server, so the Trade tab showed "No offers right now".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('vite proxy targets', () => {
  it('uses SERVER_PORT for every proxy target', () => {
    const src = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8');
    const literalTargets = src.match(/target:\s*['"]http:\/\/localhost:\d+['"]/g) ?? [];
    expect(literalTargets).toEqual([]);
  });
});
