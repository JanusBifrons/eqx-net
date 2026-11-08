# Solar-system sectors

**Status:** on by default since 2026-11-08 (wrap-up plan W1c). `EQX_SOLAR_SECTORS=0` on the server or `?solar=0` in the page turns them off and gives the old ±5,000 u sectors.

## Why

The capital-ship work needed room: "dramatically increase sector sizes and everything now needs spreading out to allow room for capitals to operate" (user, 2026-11-05). Scaling the old sector up spread everything thin. A solar-system sector is instead mostly empty space with a few busy **pockets**, and a way to cross between them (warp-to). Most of the sector is never streamed, so the cost stays close to the old small sector (see "Cost" below).

## Layout

A sector spans ±200,000 u (`SOLAR_SECTOR_HALF_EXTENT`). `sectorSites(sectorKey)` (`src/core/galaxy/sectorSites.ts`) lays out its pockets. The layout is deterministic per sector key: server and client derive the same one, and nothing is saved.

| Pocket | Where | What happens there |
|---|---|---|
| `home` | the origin, r 5 km | Today's whole sector: bases, belts, spawns. Saved structures keep their coordinates. |
| `gate:<neighbour>` | 170 km out, on the bearing toward that system on the galaxy map, r 3 km | That neighbour's Ancients' gate. Arrivals from that system (bots, haulers, convoys) come in here. |
| `belt:<n>` | 60–140 km out, r 4 km | Mining fields: two rings of rocks (`beltPocketAsteroids`). Sectors with asteroid or mineral features get two belts. |
| `base:0` | 60–140 km out, r 4 km | The outer NPC base, when the sector has two or more. |
| `combat:0` | 60–140 km out, r 3 km | World events and elites (`pocketCentre(…, 'combat')`). |

Rules the generator keeps: pockets are at least 50 km apart, every pocket has another within 150 km (no isolated outpost), and belt, base and battle pockets stay off the gate bearings.

So in Sol Prime the Vega Reach gate is due east of Home, and warping there flies straight right.

## Moving around

- **Warp-to** crosses the sector: spool 3 s, run at 20,000 u/s, drop at the pocket's rim facing the ship. The server accepts a warp only to a pocket rim (`isWarpDropPoint`). Player-facing story: [docs/features/warp-to.md](../features/warp-to.md).
- **The destination picker** (speed dial, Warp ▸) lists the pockets by name and distance.
- **Transit pads** link Home to one other pocket in about a third of systems: instant, free and safe. The rarity was the user's call (2026-11-08). See `pocketPadPair` and [docs/features/warp-to.md](../features/warp-to.md).
- **A warp run is out of the world**, and so is a sector-to-sector trip: the ship is hidden, can't be targeted and collides with nothing ([travel-state.md](travel-state.md)).
- **Sector-to-sector** arrivals land at the gate pocket facing the system they came from.

## Who uses the pockets

- **Hunter squads and respawns:** `squadEdgePose` / `sectorEdgePose` arrive on a gate pocket's rim.
- **Trade haulers:** arrive through a gate pocket and fly to the dock. The inbound leg allows 200 u/s, so a 170 km leg doesn't time out.
- **NPC convoys:** fly the lane between the gate pocket facing their other base and the base (`solarLanePoint`), so they cross open space and can be intercepted.
- **Elites and world events:** use the battle-zone pocket.
- **The client sky:** shows the system's own few distant bodies, drifting as you cross it (`Backdrop`).

**A sector with no pockets** (switch off, or a test room whose key is not a galaxy sector) uses the classic edge (`HOME_POCKET_HALF_EXTENT`), never the ±200 km extent. Before W1c, test-room haulers spawned 190 km out and never docked.

## Cost

Measured on the same machine in the same session (2026-11-08):

- **Synthetic, 500 ships spread over the whole sector** (`sectorSpace.measure.test.ts`, `diag/sector-space/`):
  - classic: tick median 1.33 ms, p95 2.54 ms, 305 KB/s to the pilot, 281 entities in view;
  - solar: tick median 1.26 ms, p95 3.26 ms, 141 KB/s, 0 in view.
- **The live galaxy:** `scripts/soak-galaxy.ts` boots the real server with every sector and the directors, parks a pilot in Sol Prime and samples for 10 minutes. Results are in `diag/soak/`, and the numbers are in the W1c PR.

## Tests

- `src/core/galaxy/sectorSites.test.ts`: the layout rules, the pads' rarity, and the gate search at solar extents.
- `tests/integration/sectorRoom/warpTo.test.ts`: the warp lands on the rim it asked for, in any direction; a non-rim point is refused; an onlooker sees the run.
- `tests/integration/sectorRoom/pocketPads.test.ts`: pads are seeded, paired, and carry a pilot.
- `src/server/livingworld/population.solar.test.ts`: arrivals land on gate pockets.

## Turning it off

- **Server:** `EQX_SOLAR_SECTORS=0`.
- **Page:** `?solar=0`. The renderer worker gets `;solar=0` in its name so it agrees with the page.
- **A single test room:** the room option `solarSectors: false`. This sets the room's own rules (warp drop points, the placement clamp); process-wide placement (arrivals, convoys) follows the env switch.
