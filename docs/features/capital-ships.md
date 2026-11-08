# Capital ships

Capital ships are the galaxy's warships: destroyers, light and heavy cruisers, battlecruisers and battleships, kilometres long, with turreted naval guns. They are NPC-only (`npcOnly`); players fight them and their escorts. The design, hull styles and combat rules are in `docs/architecture/` (capital-ship R&D); this page is the player-facing story and grows as wrap-up step W2 lands.

## Flagship fleets (wrap-up W2a)

Somewhere in the galaxy there is always a **flagship fleet**: one capital ship with an escort of two destroyers and four gunships.

- **Where it is.** The galaxy map shows it: hovering a system or opening its drawer reads "⚓ Capital sighted: the Battleship Warspite". A notice goes out when a new fleet arrives and when a flagship is destroyed.
- **How it moves.** It holds a pocket of a solar-system sector for a few minutes, then the whole fleet spools up and warps to another pocket together, the capital's slow turn making its spool the long one. Every third move it heads for a gate and crosses into a neighbouring system, arriving at that system's gate facing back. A fleet always arrives in a new system through a gate.
- **How strong it is.** The capital's class follows the sector's power: a power's heartland fields battleships and battlecruisers, neutral ground cruisers. The flagship is named, carries half again its class's hull, and a bounty for whoever sinks it.
- **Escorts** hold stations round the flagship, outside its hull, turning with its heading. When the flagship is destroyed the escorts break off and jump out, and a new fleet arrives elsewhere about fifteen minutes later.
- **It's neutral until provoked**, like other drone-side ships: fire on it and it fights back.
- **Never load-shed.** The flagship is an elite and the escorts are exempt, so a busy server never quietly removes them.
- **It survives a restart**, at the pocket it was in, with the same name and class.

### How it works

- `FlagshipDirector` (`src/server/livingworld/`) runs on the drone director's control tick (~1.5 s), never the 60 Hz loop.
- Ids start `flagship-` (`isDirectorBotId`). Moves use the NPC warp (`SectorRoom.warpBot`, see [warp-to](warp-to.md)), which lands clear of rocks and ships. Escort stations are `escortRing(capital, escort)`: both hulls' radii plus a fifth of the capital's.
- The map reads `SectorLiveState.capital` (snapshot, #16); notices are accelerators.
- Persisted in `allegiance_director_state`, row `flagships`. Kill switch: `EQX_DISABLE_FLAGSHIPS=1`.
- Locks: `FlagshipDirector.test.ts`, `LoadShedder.test.ts`, `tests/integration/sectorRoom/flagshipFleet.test.ts`, `galaxyTooltip.test.ts`.
