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

## Still to come (M2)

Patrols: a squad of the owner's fighters roaming the garrison's approaches, ignoring neutral pilots and engaging anyone hostile to the owner, with the owner's faction carried to clients so they can tint them.

## Testing

| Layer | File |
|---|---|
| Seed sweep (pure) | `src/core/bases/military.test.ts`: hearts have a garrison unless a big base holds them; edges are neutral entry sectors; owners (power at the heart, militia at the edge); fenced, more guns than working structures, every gun outside the fence |
| Generator | `growBase.test.ts` (every role legal, connected, powered; a military base has no dock), `galaxyBases.test.ts` (extras stay small, except garrisons) |
| Integration | `tests/integration/sectorRoom/galaxyBases.test.ts`: a real Sol Prime room grows the power's garrison in full, with guns and owner + allies gates |
