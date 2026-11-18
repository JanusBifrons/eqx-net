/** Join flow stage 3: every flyable hull has a committed Hangar picture
 *  (`pnpm ships:portraits`). Here, not beside shipPortraits.ts: src/client
 *  may not read the file system. */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PORTRAIT_KINDS } from '../../src/client/render/art/shipPortraits.js';

describe('ship portrait files', () => {
  it('every flyable hull has a committed picture', () => {
    const missing = PORTRAIT_KINDS.filter((k) => !existsSync(path.resolve('public/ships', `${k}.webp`)));
    expect(missing).toEqual([]);
  });
});
