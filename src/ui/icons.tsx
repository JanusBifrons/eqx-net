/**
 * The icon registry: one place that maps a game meaning to its icon.
 * Features render `<EqxIcon name="patrol" />`; they never import an icon directly.
 *
 * - LINE icons, as the approved mock-ups (.resume/ui-spec/mockups.html `const I`):
 *   24x24 viewBox, no fill, stroke currentColor, round caps and joins. EqxIcon
 *   sets the stroke; each entry here is only the shapes.
 * - Names marked "mock" use the mock's path exactly (mock key in brackets when it
 *   differs). Names marked "new" have no path in the mock and were drawn in the
 *   same style; the owner reviews those.
 * - One icon means one thing: no two names draw the same shapes (tested).
 * - `EqxIconName` is a string union, so a typo fails tsc.
 */
import type { ReactElement } from 'react';

/** Every game meaning the registry knows. Add a name here and in EQX_ICONS together. */
export const EQX_ICON_NAMES = [
  // Fleet orders
  'defend',
  'patrol',
  'hunt',
  'escort',
  'retreat',
  // Stances
  'defensive',
  'aggressive',
  'holdFire',
  // a mixed selection
  'mixed',
  // Quick actions
  'move',
  'stop',
  'trade',
  'target',
  'build',
  'pilot',
  'boost',
  // Doing mode (placing, route points)
  'rotate',
  'gate',
  'mirror',
  'confirm',
  'cancel',
  'undo',
  // Chrome
  'cog',
  'close',
  'back',
  // Right rail (build and trade above)
  'contacts',
  'hold',
  'fleet',
  'galaxy',
  'jobs',
  'faction',
  // Panel sections
  'details',
  'orders',
  'route',
  'power',
  // Selection identity (what the left strip names)
  'ship',
  'structure',
  'pod',
  'rock',
  // Lists and tables
  'filter',
] as const;

export type EqxIconName = (typeof EQX_ICON_NAMES)[number];

/** Name -> line shapes (children of a 24x24 svg). `satisfies` makes a missing or extra name a tsc error. */
export const EQX_ICONS = {
  // mock
  defend: <path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" />,
  // mock
  patrol: (
    <>
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M7 17c6-1 4-9 10-10" strokeDasharray="2 2.2" />
    </>
  ),
  // mock
  hunt: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
    </>
  ),
  // mock
  escort: (
    <>
      <path d="M12 4l5 8h-10z" />
      <path d="M5 20l3-5M19 20l-3-5" />
    </>
  ),
  // mock
  retreat: <path d="M19 12H5M11 6l-6 6 6 6" />,
  // mock [defn]
  defensive: (
    <>
      <path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  // mock [aggr]
  aggressive: <path d="M4 20L20 4M14 4h6v6" />,
  // mock [holdfire]
  holdFire: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  // new: three dots (a selection whose ships differ)
  mixed: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  // new: the in-world move-order mark (render/FleetOverlay.ts): the ring that
  // flashes outward at the tapped point around its destination dot. No order
  // line: a line touching the ring read as a magnifying glass.
  move: (
    <>
      <circle cx="12" cy="12" r="8.5" opacity="0.45" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  // new: two chevrons pointing ahead (the boost impulse along the facing)
  boost: <path d="M6 13l6-6 6 6M6 19l6-6 6 6" />,
  // mock
  stop:<rect x="6" y="6" width="12" height="12" rx="1.5" />,
  // mock
  trade: <path d="M4 8h15l-3-3M20 16H5l3 3" />,
  // new: the in-world LOCKED mark (render/AimFeedbackRenderer.ts), four corner
  // brackets round the target (the mock's Target button borrows `contacts`, which is taken)
  target: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  // mock
  build: (
    <>
      <rect x="3" y="12" width="8" height="8" rx="1" />
      <rect x="13" y="12" width="8" height="8" rx="1" />
      <rect x="8" y="3" width="8" height="8" rx="1" />
    </>
  ),
  // mock
  rotate: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  // mock
  mirror: <path d="M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z" />,
  // mock [check]
  confirm: <path d="M4 12l5 5L20 6" />,
  // new: circled cross (the mock's bare `x` is `close`)
  cancel: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  // mock
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  // mock
  cog: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  // mock [x]
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // new: chevron left
  back: <path d="M15 5l-7 7 7 7" />,
  // mock
  contacts: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-6" />
    </>
  ),
  // mock
  hold: (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ),
  // mock
  fleet: <path d="M6 4l4 7H2zM18 4l4 7h-8zM12 13l4 7H8z" />,
  // mock
  galaxy: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-25 12 12)" />
    </>
  ),
  // mock
  jobs: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6v3H9zM8.5 12h7M8.5 16h5" />
    </>
  ),
  // mock
  faction: <path d="M5 21V4M5 4h12l-2.5 4L17 12H5" />,
  // new: circled i
  details: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.01" />
    </>
  ),
  // new: loud-hailer
  orders: (
    <>
      <path d="M4 10v4h3l8 4V6l-8 4z" />
      <path d="M19 9.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  // new: two stops joined by a winding line
  route: (
    <>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16" />
    </>
  ),
  // new: bolt
  power: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  // new: ship's wheel (take the helm of a parked hull)
  pilot: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 3v7M12 14v7M3 12h7M14 12h7" />
    </>
  ),
  // new: a fighter seen from above, nose up (a single hull; `fleet` is a group of them)
  ship: <path d="M12 3l2 6 7 6.5v2L14 15l-1 4 2 2H9l2-2-1-4-7 2.5v-2L10 9z" />,
  // new: a hexagon, the radar / contacts structure shape (render/entityVisuals.ts), with a core
  structure: (
    <>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  // new: small crate with a strap (a cargo pod; `hold` is the ship's hold)
  pod: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="2" />
      <path d="M5 11h14M10 7v4M14 7v4" />
    </>
  ),
  // new: lumpy rock
  rock: <path d="M7 5l6-2 6 4 2 7-4 6-8 1-5-5 1-7z" />,
  // new: two fence posts with an open arch between (a gate in a shield fence)
  gate: <path d="M4 20V5M20 20V5M4 9h3M17 9h3M7 20v-8a5 5 0 0 1 10 0v8" />,
  // new: funnel (show or hide a list's filters)
  filter: <path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" />,
} as const satisfies Record<EqxIconName, ReactElement>;
