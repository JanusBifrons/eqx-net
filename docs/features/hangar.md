# The Hangar

<!-- showcase-exempt: the film comes with the join-flow showcase shot once stage 6 (sign-in at Launch) lands; stills go to the owner first -->

The Hangar is where a pilot picks what to launch into a sector. The way in is: galaxy map, then tap a sector, then **Join the fight**, then the Hangar, then **Launch**. It replaced the old ship picker and the ship roster in join flow stage 5.

## What the pilot sees

- **Header:** "Hangar · <sector>", the credit balance (red when in debt) and gold pips for the free capital launches left (out of `FREE_LAUNCHES_START`).
- **Class tabs:** Sub-capitals | Capitals. Each tab says how many of its hulls can launch right now ("· N ready"). More tabs (Fighters, Bombers, Transports, Location) are one entry each in `HANGAR_TABS`.
- **One tile per hull.** A capital's fits (naval, rail, beam, lance) fold into one tile with a toggle row underneath. Each tile shows the hull's price, "Free", "Free launch" or "Owned". Shipyard hulls (Heavy, Interceptor, Gunship, Missile Frigate, Barge) are greyed out until built.
- **Owned here:** a hull you own that is parked in this sector has a gold edge. Launch resumes it (free); **Abandon** breaks it up exactly as its death would. Abandoning the hull you are flying ejects you to the galaxy map.
- **Footer:** what this launch costs and the balance after it. Launch is disabled when the launch is refused.

## How it works

- **One answer for client and server.** Every tile and the footer ask `hangarModel.tileVerdict`, which calls the shared `launchVerdict` in `shared-types/launch.ts` — the same call the server's launch gate makes. The window can never promise a launch the server refuses. Prices and the free-launch rule: [economy-wallet](economy-wallet.md).
- **Tabs come from `sizeClass`.** `hangarModel.HANGAR_TABS` lists the classes per tab; the hull list is the flyable kinds minus engineering-only hulls. Fits fold through `capitalClassAndFitOf(kind)`, so the client never parses kind ids.
- **Credits:** read from `/trade/economy` each time the window opens, falling back to the last snapshot's `wallet` / `freeLaunches` in the store.
- **Owned hulls** come from the store's `shipRoster`, fed by the refcounted `rosterPoller` from `GET /hangar/ships` (served in production; the `/dev/player-ships` route stays for tests). Abandon is `POST /hangar/ships/:id/abandon` (`components/hangar/useAbandonShip.ts`); an account-bound ship needs that account's Bearer token.
- **Mount:** `GalaxyPickerChrome` mounts `HangarWindow` for the pending sector and calls the existing `onSpawnNewShip` / `onSpawnExistingShip`. In-game ship swap is the same path: map → sector → the owned tile.

Files: `src/client/components/hangar/` (`HangarWindow.tsx`, `hangarModel.ts`, `useAbandonShip.ts`).

Testids: `hangar-window`, `hangar-wallet`, `hangar-free-launches` (`data-count`), `hangar-tab-<tabId>`, `ship-card-<tileId>` (`data-selected`, `data-owned`, `data-verdict`), `hangar-fit-<kind>`, `hangar-cost`, `hangar-after`, `hangar-abandon`, `hangar-close`, `hangar-launch`.

Locks: `hangarModel.test.ts`, `HangarWindow.test.tsx`, `GalaxyPickerChrome.test.tsx`, `tests/e2e/ship-selection.spec.ts`, `spawn-select-flow.spec.ts`, `happy-path-switch-ship.spec.ts`.

## Future plans

- Ship pictures on the tiles (`shipPortraitUrl`) replace the outline silhouettes.
- The Hangar takes the loot window's shared dialog chrome.
- Sign-in moves to Launch, with "Play as guest" beside it.
- Quick launch: one map button to the hottest sector.

## History

- Join flow stage 5 (2026-11-18): the Hangar replaced `ShipPickerModal`; `ShipRosterPanel`, `ShipDetailModal`, `GalaxyOverviewSelectChrome`, `RosterCountBadge` and the drawer's roster section were removed; launch prices switched on (`LAUNCH_COSTS_ON = true`).
