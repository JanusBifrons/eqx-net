# Military bases

Plan `soft-leaping-truffle` v4, phase M. The one base role the production chains never had: a garrison. Military bases guard a region's heart and its open frontier. They're fenced, built mostly of guns, and they admit only their owner and allies.

## Where they are (M1)

Military bases are placed by their own deterministic pass (`militarySites`, `galaxyBases.ts`), never rolled. Every other base rolls exactly as before.

- **The heart garrison.** Each region's heart holds its power's garrison, unless the heart's own base is already a stronghold or citadel (that base garrisons itself). It is a stronghold beside a small base, else a settlement, sized so it always fits.
- **The edge outpost.** Each region's first neutral entry sector (by key) gets a settlement-sized outpost. The galaxy's edge is where raiders warp in. The region's militia company owns it; if the region has none, its power does. It never shares the region's transit-hub sector.
- **Room in the sector.** A garrison makes room under the sector's structure budget by dropping extra bases (never base 0 or a hub).

## What one is

- **Fenced, every time,** with its gates set to **owner + allies**. Anyone else stays outside.
- **Turret-heavy.** Its production list is every kind of gun (laser, bolt, autocannon, missile), repeated while its wealth lasts. Garrisons are funded at twice their tier's top wealth.
- **Guns outside the fence.** A fence stops its owner's own shots, so every gun sits on a bastion outside it. A garrison gets a bastion row for every six guns it buys.
- **One more mine layer** than a trading base of its size.
- **No freight dock.** It trades nothing: its cargo bay holds the munitions and fuel it's stocked with.

## Patrols (M2)

Every garrison flies a patrol: three `patrol-fighter`s, four for a stronghold. `PatrolSubsystem` (`src/server/bases/`) runs them on the 1 Hz structure pulse.

- **Where they fly.** Each ship flies the four corners of the base, just outside its fence, in turn. Each starts at a different corner, so the squad spreads round the base. A ship spawns at its corner: a fence stops every ship and gates open only for pilots, so a patrol born inside could never leave.
- **Who they fight.** A patrol fighter's allegiance is the Traders': no one is hostile to it on sight, and it is hostile to no one on sight, except robots, who attack everything.
  - **Engaging.** Once a second, any pilot within 3500 units of the base whose relation to the owner is **hostile** is marked hostile to every ship of the patrol, and the clients hear about it once (`bot_aggro`). Hostile means a hostile act against the base, or standing below the owner's threshold.
  - **Everyone else** is left alone, and the AI forgets a hostile pilot who stays away.
- **Losses.** A lost ship comes back after a minute.
- **On the wire.** Each patrol ship's snapshot entry always carries `drones[].fac`, the faction it flies for (#16). Clients keep it and tint the ship in that faction's colour.
- Patrol ids start `patrol-`, registered in `isDirectorBotId`, so damage, XP and missiles treat them as NPCs. They aren't saved: they regenerate with their base.

## Testing

| Layer | File |
|---|---|
| Seed sweep (pure) | `src/core/bases/military.test.ts`: hearts have a garrison unless a big base holds them; edges are neutral entry sectors; owners (power at the heart, militia at the edge); fenced, more guns than working structures, every gun outside the fence |
| Generator | `growBase.test.ts` (every role legal, connected, powered; a military base has no dock), `galaxyBases.test.ts` (extras stay small, except garrisons) |
| Integration | `tests/integration/sectorRoom/galaxyBases.test.ts`: a real Sol Prime room grows the power's garrison in full, with guns and owner + allies gates |
| Patrols (unit) | `src/server/bases/PatrolSubsystem.test.ts`: spawn outside the fence at different corners, fly corner to corner, engage only a hostile pilot in range, respawn after the delay |
| Patrols (integration) | `tests/integration/sectorRoom/patrols.test.ts`: in a real Sol Prime room the patrol carries `fac` on the snapshot, ignores a neutral pilot, and engages once the pilot attacks the garrison |
| Client | `snapshotRemoteSync.charging.test.ts`: a patrol ship keeps its faction |
