# Building panels

How you look at and manage one of your buildings: a small card at the top of the screen, and a side panel for everything else.

## What the player sees

- **Selection card (top-centre).** Tap any object and a compact card docks at the top-centre of the screen, never over the object. For a building it shows the name, level, a hull bar, a power icon (gold OK, red short, grey off) and one status chip (building %, breach, no fuel / no munitions, or what it is making). A building that makes things adds a small slot with the current item and its progress. Pilot services stay on the card in every mode: Repair ship, Refine salvage, Open cargo, and Unpack for packed hulls in your storage (picture tiles with ×N).
- **Open (Build mode only).** Your own building's card has one **Open** button in Build mode. In Fly and Command the card is read-only.
- **Side panel.** Open docks a panel on the right, with no dark backdrop: the map stays live and you can still tap other things. It takes ~40% of a sideways phone (at least 280 px) and 360 px on a desktop; held upright it is a bottom sheet. In Build or Command the camera glides once so the building sits in the middle of the free space. Esc closes it on a desktop; selecting something else closes it too.
- **Tabs: Power / Build / Manage** (Build only on buildings that make things).
  - **Power:** a bar of this building's draw (or a generator's output) against the grid's net, "+N spare" in green or "−N short" in red; an On/Off switch; presets 0 / 20 / 50 / 80 / 100% over the throttle slider; a note when the grid can't take the building's full draw.
  - **Build:** for the Shipyard, picture tiles of every hull it can make, each with its cost. Tap a tile to add one to the queue, hold it to add five. Hulls mix freely in one queue (interceptor, gunship, interceptor...); tap a queued item to take it out, and ∞ repeats the whole list. A tile is locked until its blueprint is in the slot or in your connected storage; the right blueprint is swapped into the slot when its turn comes. The Shipyard draws an outline of each queued hull at its own size. Other processors keep the recipe and "N left / Forever" counter.
  - **Manage:** a gate's access setting, the Upgrade card (next level and its cost), Reconnect / Clear links, and Deconstruct: hold it for a second to confirm (a fill shows the hold; letting go early cancels).

## How it works

- Card: `EntityStatsPanel` + `structureCard.tsx`, mounted in `<Slot anchor="top-center">` (App.tsx). Placement rules: [mobile-layout](mobile-layout.md).
- Panel: `StructureSettingsModal` on the shared `SidePanel` shell (also the galaxy sector panel); size `SETTINGS_PANEL_SIZE`; camera glide `panelCameraNudge.ts` + `buildModeView.queuePanelNudge`; Build-mode gate `canManageBuildings`.
- Build tab, recipe queue, blueprint swap and blueprint stock: [production-chains](../architecture/production-chains.md). Power tab: [structures-and-power-grid](../architecture/structures-and-power-grid.md). Hull tiles: `HullTile` (shared with the [Hangar](hangar.md)).
- Testids: `entity-stats-panel`, `entity-stats-card`, `structure-action-settings` (Open), `structure-settings` (panel), `structure-settings-tab-<power|production|access>`, `structure-settings-close`, `build-queue`, `build-queue-forever`, `hull-tile-lock`, `settings-power-presets`, `structure-upgrade-card`, `structure-action-deconstruct`.

## History

- **Building-panels redesign (2026-11-21):** the card used to float over the selected object every frame (`inspectorPlacement.ts` / `inspectorHold.ts`, removed) and carried all the owner buttons; the settings window was a centred modal with a per-recipe build count. Now the card is compact and docked, management moved into the side panel, and the Shipyard takes a mixed hull queue.
