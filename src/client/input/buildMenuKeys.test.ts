import { describe, it, expect } from 'vitest';
import { buildMenuKeyAction, stepCategory } from './buildMenuKeys';

describe('buildMenuKeyAction', () => {
  it('1–9 pick the Nth tile', () => {
    expect(buildMenuKeyAction('1', 'Digit1')).toEqual({ kind: 'pick', index: 0 });
    expect(buildMenuKeyAction('9', 'Digit9')).toEqual({ kind: 'pick', index: 8 });
    expect(buildMenuKeyAction('!', 'Digit1')).toEqual({ kind: 'pick', index: 0 });
  });
  it('Q / E step to the previous / next category', () => {
    expect(buildMenuKeyAction('q', 'KeyQ')).toEqual({ kind: 'step', delta: -1 });
    expect(buildMenuKeyAction('E', 'KeyE')).toEqual({ kind: 'step', delta: 1 });
  });
  it('ignores other keys (0, WASD, T, Escape)', () => {
    expect(buildMenuKeyAction('0', 'Digit0')).toBeNull();
    expect(buildMenuKeyAction('w', 'KeyW')).toBeNull();
    expect(buildMenuKeyAction('t', 'KeyT')).toBeNull();
    expect(buildMenuKeyAction('Escape', 'Escape')).toBeNull();
  });
});

describe('stepCategory', () => {
  const ids = ['a', 'b', 'c'] as const;
  it('steps and wraps at both ends', () => {
    expect(stepCategory(ids, 'a', 1)).toBe('b');
    expect(stepCategory(ids, 'c', 1)).toBe('a');
    expect(stepCategory(ids, 'a', -1)).toBe('c');
    expect(stepCategory(ids, 'b', -1)).toBe('a');
  });
});
