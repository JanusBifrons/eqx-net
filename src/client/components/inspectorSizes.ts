/**
 * Inspector (EntityStatsPanel) sizes. Its text is `{ xs, sm }` responsive:
 * tiny below MUI's `sm` width breakpoint, ~2x above it for desktop. A
 * sideways phone (863 px wide) is past `sm`, so it drew the desktop ~16 px
 * text and the card grew too big to sit between the helm row and the status
 * capsule (#1046). The panel root carries `INSPECTOR_PHONE_ATTR` when the HUD
 * size class (useHudSize) is `phone`; under it every sized property is pinned
 * to its xs value ("start tiny").
 */
import { useHudSize } from '../hud/useHudScale';

export const INSPECTOR_PHONE_ATTR = 'data-hud-phone';
const UNDER_PHONE = `[${INSPECTOR_PHONE_ATTR}] &`;

/** `{ prop: [xs, sm] }` → responsive sizes, xs-only under a phone root. */
export function phoneTiny(sizes: Record<string, readonly [number, number]>): Record<string, unknown> {
  const sx: Record<string, unknown> = {};
  const phone: Record<string, number> = {};
  for (const [prop, [xs, sm]] of Object.entries(sizes)) {
    sx[prop] = { xs, sm };
    phone[prop] = xs;
  }
  sx[UNDER_PHONE] = phone;
  return sx;
}

const PHONE_ATTRS = { [INSPECTOR_PHONE_ATTR]: '' };
const NO_ATTRS = {};

/** Root attributes for the inspector: the phone marker when the HUD is `phone`. */
export function useInspectorPhoneAttrs(): Record<string, string> {
  return useHudSize() === 'phone' ? PHONE_ATTRS : NO_ATTRS;
}
