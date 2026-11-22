/** Contacts → selection (UI plan D10 T5): a row's lock key maps to the id +
 *  kind the renderer's map pick uses, so a row tap selects like a map tap. */
import { describe, expect, it } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { contactFocusTarget } from './contactFocus';

const mirror = {
  localPlayerId: 'me',
  ships: new Map<string, unknown>([
    ['me', { x: 0, y: 0, kind: 'fighter' }],
    ['pilot-1', { x: 0, y: 100, kind: 'fighter' }],
    ['hull-9', { x: 0, y: 200, kind: 'fighter', isActive: false }],
  ]),
} as unknown as RenderMirror;

describe('contactFocusTarget', () => {
  it('a swarm ship row focuses the drone `swarm-<n>`', () => {
    expect(contactFocusTarget('s:7', 'ship', mirror)).toEqual({ id: 'swarm-7', kind: 'drone' });
  });
  it('a structure row focuses the structure `swarm-<n>`', () => {
    expect(contactFocusTarget('s:42', 'structure', mirror)).toEqual({ id: 'swarm-42', kind: 'structure' });
  });
  it('a player ship row focuses the mirror key as a ship', () => {
    expect(contactFocusTarget('p:pilot-1', 'ship', mirror)).toEqual({ id: 'pilot-1', kind: 'ship' });
  });
  it('a parked hull focuses as lingering, like the map pick', () => {
    expect(contactFocusTarget('p:hull-9', 'ship', mirror)).toEqual({ id: 'hull-9', kind: 'lingering' });
  });
  it('a ship that left the mirror still focuses as a ship', () => {
    expect(contactFocusTarget('p:gone', 'ship', mirror)).toEqual({ id: 'gone', kind: 'ship' });
  });
  it('an unknown or empty key focuses nothing', () => {
    expect(contactFocusTarget('x:1', 'ship', mirror)).toBeNull();
    expect(contactFocusTarget('s:', 'ship', mirror)).toBeNull();
    expect(contactFocusTarget('p:', 'ship', mirror)).toBeNull();
  });
});
