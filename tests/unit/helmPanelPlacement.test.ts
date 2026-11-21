/**
 * The Command speed telegraph (`HelmPanel`) never floats over the play area:
 * in Command a right-click / tap on the map is a move order, and the bar
 * slotted in the top-centre anchor swallowed the orders given on that spot
 * (tests/e2e/fleet-command.spec.ts right-clicks there). It rides the fleet
 * panel / strip instead (bottom edge, already reserved while ships are
 * selected; locked in `FleetPanel.test.tsx`). Source-level lock on App's slots.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../../src/client/App.tsx', import.meta.url)), 'utf8');

describe('HelmPanel placement', () => {
  it('is not slotted on its own (no top-centre bar over the Command map)', () => {
    expect(/<Slot[^>]*>\s*<HelmPanel\s*\/>/.test(app)).toBe(false);
  });
});
