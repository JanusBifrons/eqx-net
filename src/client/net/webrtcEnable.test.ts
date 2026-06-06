import { describe, it, expect } from 'vitest';
import { webrtcEnabledFromSearch } from './webrtcEnable';

describe('webrtcEnabledFromSearch — DataChannel default-on gate', () => {
  it('defaults ON for real users (no param, not automation)', () => {
    expect(webrtcEnabledFromSearch('', false)).toBe(true);
    expect(webrtcEnabledFromSearch('?room=galaxy-sol-prime', false)).toBe(true);
    expect(webrtcEnabledFromSearch(null, false)).toBe(true);
    expect(webrtcEnabledFromSearch(undefined, false)).toBe(true);
  });

  it('defaults OFF under automation (Playwright webdriver) so E2E stays WS + netgate stays valid', () => {
    expect(webrtcEnabledFromSearch('', true)).toBe(false);
    expect(webrtcEnabledFromSearch('?room=feel-test-25&diag=0', true)).toBe(false);
  });

  it('explicit ?webrtc=1 forces ON, overriding the automation default', () => {
    expect(webrtcEnabledFromSearch('?webrtc=1', true)).toBe(true);
    expect(webrtcEnabledFromSearch('?webrtc=1', false)).toBe(true);
  });

  it('explicit ?webrtc=0 forces OFF, overriding the real-user default', () => {
    expect(webrtcEnabledFromSearch('?webrtc=0', false)).toBe(false);
    expect(webrtcEnabledFromSearch('?webrtc=0', true)).toBe(false);
  });

  it('ignores non-0/1 webrtc values and falls back to the default', () => {
    expect(webrtcEnabledFromSearch('?webrtc=yes', false)).toBe(true);
    expect(webrtcEnabledFromSearch('?webrtc=yes', true)).toBe(false);
  });
});
