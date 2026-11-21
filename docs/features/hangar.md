# The Hangar

<!-- showcase-exempt: the film comes with the join-flow showcase shot once stage 6 (sign-in at Launch) lands; stills go to the owner first -->

The Hangar is where a pilot picks what to launch into a sector. The way in is: galaxy map, then tap a sector, then **Join the fight**, then the Hangar, then **Launch**. It replaced the old ship picker and the ship roster in join flow stage 5.

## What the pilot sees

The look follows the approved join-flow mock-up (HUD tokens in `hud/tokens.ts`: Chakra Petch labels, JetBrains Mono numbers, cyan for the pick and LAUNCH, gold for credits and owned hulls).

- **Header:** "Hangar", "Launching into <sector>", the credit balance (red when in debt), cyan diamond pips for the free capital launches left (out of `FREE_LAUNCHES_START`), and a close button.
- **Class tabs:** Sub-capitals | Capitals, each with an "N ready" chip. More tabs (Fighters, Bombers, Transports, Location) are one entry each in `HANGAR_TABS`.
- **Left: square picture tiles.** "Ready to launch" first, then "Shipyard hulls" (Heavy, Interceptor, Gunship, Missile Frigate, Barge), greyed out until built. Each tile shows the ship picture (`shipPortraitUrl`, outline silhouette as a fallback), its name and "<price> cr", "Free", "Owned" or "Shipyard". Capitals have a blue edge; a capital with several fits carries an "N fits" badge.
- **Right: the detail pane.** A big picture with the class line ("Capital · Railguns fit") and name, the fit buttons (Guns, Railguns, Lances, Beams), Hull and Speed bars scaled to the toughest and fastest hull in the Hangar, a line on what the ship is for, and why a launch is or isn't possible (a free launch, debt, Shipyard).
- **Owned here:** a hull you own that is parked in this sector has a gold edge. Launch resumes it (free); **Abandon this ship** breaks it up exactly as its death would. Abandoning the hull you are flying ejects you to the galaxy map.
- **Footer:** "Cost …" and "After launch … cr" (plus free launches left), **Back to map** and **LAUNCH ▸**; when refused, "Can't launch this from here" and LAUNCH is disabled.
- **Signed out:** Join still opens the Hangar. The footer shows **Play as guest** and **SIGN IN TO LAUNCH ▸**. Sign in goes to the login page and comes back to this Hangar with the same sector and hull picked. Play as guest remembers the choice and launches at once.
- **Phones:** two columns above 760 px wide (a sideways phone), one scrolling column below.
- **Quick launch (skips the Hangar):** the landing map has a **QUICK LAUNCH ▸** button bottom-right. One tap picks the safest sector (no hostiles, else the fewest), glides the map into it ("Warping into <sector>…") and launches the free Fighter there, as a guest when signed out. It hides while a sector's panel or the Hangar is open, and on the in-game warp map.

## How it works

- **One answer for client and server.** Every tile and the footer ask `hangarModel.tileVerdict`, which calls the shared `launchVerdict` in `shared-types/launch.ts` — the same call the server's launch gate makes. The window can never promise a launch the server refuses. Prices and the free-launch rule: [economy-wallet](economy-wallet.md).
- **Tabs come from `sizeClass`.** `hangarModel.HANGAR_TABS` lists the classes per tab; the hull list is the flyable kinds minus engineering-only hulls. Fits fold through `capitalClassAndFitOf(kind)`, so the client never parses kind ids.
- **Credits:** read from `/trade/economy` each time the window opens, falling back to the last snapshot's `wallet` / `freeLaunches` in the store.
- **Owned hulls** come from the store's `shipRoster`, fed by the refcounted `rosterPoller` from `GET /hangar/ships` (served in production; the `/dev/player-ships` route stays for tests). Abandon is `POST /hangar/ships/:id/abandon` (`components/hangar/useAbandonShip.ts`); an account-bound ship needs that account's Bearer token.
- **Quick launch** picks its sector with `components/quickLaunch.ts` `quickLaunchSector(galaxyStats)`: safety first, a sector with no hostiles, else the fewest (robots count as hostiles). A fresh launch carries the once-per-account starter crate (packed Capital) and a newcomer starts in Command view with the Fighter parked, so a sector with robots loses the crate for good within seconds. Among equally safe sectors: a hot front (the map's own pulse rule, `HOT_THREAT`), then the higher threat, recent fighting, the most pilots. The glide is the map's focus view (`onFocusChange`, `FOCUS_GLIDE_MS`); the launch is the same `onSpawnNewShip` the Hangar calls. Test id `galaxy-quick-launch` (`data-target` = the picked sector).
- **Starter Capital crate:** the first fresh launch of every account (existing ones too) puts one packed Capital (`structure:capital`, weight 25) in the launched ship's hold (`server/economy/starterGrant.ts`). The once-only flag (`starterGranted`, absent = not yet given) sits on the economy player row and lands in the same atomic group as the hold. A crate lost before placing spills with the hold and is not replaced; it never rolls as loot. Lock: `starterGrant.test.ts`.
- **The Capital crate carries its bank:** a Capital crate is one of a kind (own `uid`, `minerals` on the packed item). A fresh one (the starter grant, or a crate with no bank written) starts the Capital with 5,000 minerals (`CAPITAL_STARTING_MINERALS`); taking a Capital down repacks its current bank into the crate (`repackItem`), so pack and unpack never prints minerals. Goods in the Capital's hold drop as a pod where it stood. Lock: `capitalCrateBank.test.ts`.
- **Mount:** `GalaxyPickerChrome` mounts `HangarWindow` for the pending sector and calls the existing `onSpawnNewShip` / `onSpawnExistingShip`. In-game ship swap is the same path: map → sector → the owned tile.

Files: `src/client/components/hangar/` (`HangarWindow.tsx`, `hangarModel.ts`, `useAbandonShip.ts`).

Testids: `hangar-signin`, `hangar-guest`, `hangar-window`, `hangar-wallet`, `hangar-free-launches` (`data-count`), `hangar-tab-<tabId>`, `ship-card-<tileId>` (`data-selected`, `data-owned`, `data-verdict`), `hangar-detail`, `hangar-fit-<kind>` (in the detail pane), `hangar-cost`, `hangar-after`, `hangar-abandon`, `hangar-close`, `hangar-launch`.

Locks: `galaxy-landing-flow.spec.ts`, `hangarModel.test.ts`, `HangarWindow.test.tsx`, `GalaxyPickerChrome.test.tsx`, `tests/e2e/ship-selection.spec.ts`, `spawn-select-flow.spec.ts`, `happy-path-switch-ship.spec.ts`.

## Future plans

- A Spectate button in the footer (the mock-up has one; Back to map stands in for now).
- The Hangar takes the loot window's shared dialog chrome.
- After a Quick launch: a small "Want a bigger ship? Open Hangar" hint in game, and one "sign in to keep your credits" ask after the first fight (mock-up flow B, steps 3 and 4).

## History

- Join credits (2026-11-21): every pilot is topped up once to 75,000 credits (`JOIN_CREDITS`, was 0), enough to buy a battleship (60,000) from the first Hangar visit. [economy-wallet](economy-wallet.md).

- Quick launch safe start (2026-11-21): Quick launch picked the hot front (Ashfront, robots) every time; a new pilot's parked Fighter was shot within ~20 s and the starter Capital crate was lost for good, so no base could ever start. It now ranks safety (fewest hostiles) first.

- Join flow stage 7 (2026-11-18): Quick launch on the landing map.

- Hangar restyle (2026-11-18): rebuilt to the approved mock-up: picture tiles, a detail pane with the fits and stat bars, a ledger footer.

- Join flow stage 6 (2026-11-18): sign-in moved from "Join the fight" to the Hangar's Launch (`needsSignIn`; the stash is the existing `pendingPickSector` + `resumeGatedJoin`, plus the picked hull).
- Join flow stage 5 (2026-11-18): the Hangar replaced `ShipPickerModal`; `ShipRosterPanel`, `ShipDetailModal`, `GalaxyOverviewSelectChrome`, `RosterCountBadge` and the drawer's roster section were removed; launch prices switched on (`LAUNCH_COSTS_ON = true`).
