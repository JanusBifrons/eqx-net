import { describe, expect, it } from 'vitest';
import { INSPECTOR_PHONE_ATTR, phoneTiny } from './inspectorSizes';

// #1046 phone still: a sideways phone (863 px wide) is past the MUI `sm`
// breakpoint, so the inspector drew its desktop ~16 px text and grew to
// 349x209, too big to sit between the helm row and the status capsule.
describe('phoneTiny', () => {
  it('keeps the xs/sm breakpoint sizes and pins the xs size under the phone attribute', () => {
    expect(phoneTiny({ fontSize: [10, 20] })).toEqual({
      fontSize: { xs: 10, sm: 20 },
      [`[${INSPECTOR_PHONE_ATTR}] &`]: { fontSize: 10 },
    });
  });

  it('pins every sized property together', () => {
    const sx = phoneTiny({ width: [44, 88], height: [3, 6] });
    expect(sx[`[${INSPECTOR_PHONE_ATTR}] &`]).toEqual({ width: 44, height: 3 });
  });
});
