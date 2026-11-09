import { describe, it, expect } from 'vitest';
import { fcKeyAction } from './MouseLock';

describe('fcKeyAction', () => {
  it('digits select a group, shift+digit toggles its mode', () => {
    expect(fcKeyAction('1', 'Digit1', false)).toEqual({ kind: 'select', index: 0 });
    expect(fcKeyAction('!', 'Digit1', true)).toEqual({ kind: 'mode', index: 0 });
    expect(fcKeyAction('9', 'Digit9', false)).toEqual({ kind: 'select', index: 8 });
  });
  it('T locks the selection, X clears', () => {
    expect(fcKeyAction('t', 'KeyT', false)).toEqual({ kind: 'target' });
    expect(fcKeyAction('X', 'KeyX', true)).toEqual({ kind: 'clear' });
  });
  it('ignores other keys (0, WASD, space)', () => {
    expect(fcKeyAction('0', 'Digit0', false)).toBeNull();
    expect(fcKeyAction('w', 'KeyW', false)).toBeNull();
    expect(fcKeyAction(' ', 'Space', false)).toBeNull();
  });
});
