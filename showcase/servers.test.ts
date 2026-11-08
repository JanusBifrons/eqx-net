import { describe, it, expect } from 'vitest';
import { defaultPorts, portOffset } from './servers';

describe('capture server ports', () => {
  it('default to 2767 / 5373', () => {
    expect(defaultPorts({})).toEqual({ server: 2767, vite: 5373 });
  });

  it('shift by EQX_SHOWCASE_PORT_OFFSET', () => {
    expect(defaultPorts({ EQX_SHOWCASE_PORT_OFFSET: '300' })).toEqual({ server: 3067, vite: 5673 });
    expect(portOffset({ EQX_SHOWCASE_PORT_OFFSET: '' })).toBe(0);
  });

  it('reject a bad offset rather than guess', () => {
    expect(() => portOffset({ EQX_SHOWCASE_PORT_OFFSET: 'abc' })).toThrow(/whole number/);
    expect(() => portOffset({ EQX_SHOWCASE_PORT_OFFSET: '-5' })).toThrow();
  });
});
