import { describe, it, expect } from 'vitest';
import { shouldOfferPushToggle, urlBase64ToUint8Array, type PushEnvironment } from './pushClient.js';

const base: PushEnvironment = { supported: true, isIos: false, isStandalone: false };

describe('shouldOfferPushToggle', () => {
  it('false when push is unsupported', () => {
    expect(shouldOfferPushToggle({ ...base, supported: false })).toBe(false);
  });

  it('true on a supported non-iOS browser', () => {
    expect(shouldOfferPushToggle(base)).toBe(true);
  });

  it('false on iOS Safari that is NOT installed (push needs an installed PWA)', () => {
    expect(shouldOfferPushToggle({ ...base, isIos: true, isStandalone: false })).toBe(false);
  });

  it('true on iOS once installed (standalone)', () => {
    expect(shouldOfferPushToggle({ ...base, isIos: true, isStandalone: true })).toBe(true);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes standard base64 to the raw bytes', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
  });

  it('restores missing padding', () => {
    const expected = Array.from(atob('AQ=='), (c) => c.charCodeAt(0));
    expect(Array.from(urlBase64ToUint8Array('AQ'))).toEqual(expected);
  });

  it('maps the URL-safe alphabet (- → +, _ → /)', () => {
    const expected = Array.from(atob('a+b/'), (c) => c.charCodeAt(0));
    expect(Array.from(urlBase64ToUint8Array('a-b_'))).toEqual(expected);
  });

  it('produces an ArrayBuffer-backed view (usable as applicationServerKey)', () => {
    const bytes = urlBase64ToUint8Array('AQID');
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
  });
});
