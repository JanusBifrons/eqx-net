# NPC transit hubs

Plan `soft-leaping-truffle` v4, phase H. The alien gates (see [alien-gates.md](alien-gates.md)) only ever lead across one border. Transit hubs are the long jumps: NPC bases whose teleporters are already paired with teleporters at other bases, so a pilot can hop from a region's border to its capital, its trade bases, or the core.

## The network

The network is worked out once, deterministically, by pure shared code (`src/core/bases/transitNetwork.ts`, read through `transitNetwork()` in `galaxyBases.ts`):

- **One hub per region.** Each region (the core and the three frontier regions) has a hub: a `transit` base, settlement-sized and unfenced, in one of its chokepoint sectors (the first by key). A hub is run by the Traders in a power's heartland, and by the Traders or a freight company elsewhere.
- **Each hub links to:**
  - its region heart's main base;
  - up to two trade bases in its region, nearest first;
  - the core hub (frontier hubs only). This is the backbone.
- **Both ends of a link grow a teleporter** tagged with the link's id (`GrownPlacement.link`). The far ends are ordinary bases (a heart's citadel, a trade outpost); their teleporter is added on top of their normal build.
- **The two find each other at run time** by that id, through the teleport broker (`findLinkTwin`). Nothing is paired by position.

A hub makes room in its sector by dropping extra bases if the sector would go over its NPC structure budget. Existing bases don't move: a base's role and layout are rolled exactly as before, and only its link teleporters are new (`BASE_GROWTH_VERSION` 8).

## Riding one

- **When it fires.** A link teleporter fires **when a ship boards** (the rule from [teleporters.md](teleporters.md)), once its capacitor is charged from its base's spare power. Jumps cost what any cross-sector jump costs: the charge depends on the hops.
- **The toll.** Its owner charges a small toll, 5 credits per 1000 charge (`NPC_LINK_TOLL`). You get the usual Pay / Don't pay / Always / Never prompt. Riding without paying costs standing with the owner; it doesn't make you hostile.
- **No pairing offer.** Selecting an NPC teleporter offers no pairing (it's already linked), and the server refuses such requests.

## Still to come (H2)

Convoys and NPC traffic don't yet route through the hubs. The routing overlay (hub links counted in `hopDistance` / `nextHopToward`) and convoys riding the teleporters are the next step.

## Testing

| Layer | File |
|---|---|
| Network (pure) | `src/core/bases/transitNetwork.test.ts`: one hub per region on its border, links valid and listed at both ends, both ends grow exactly one tagged teleporter, no sector over its structure budget |
| Plans | `src/core/bases/galaxyBases.test.ts`: base 0 unchanged apart from its links; the Traders run transit hubs in held sectors |
| Integration | `tests/integration/sectorRoom/transitHubs.test.ts` (the two real rooms at a hub link's ends, real NPC bases): the ends pair by link id, fire when a ship boards, charge the toll, and carry a paying pilot to the far sector |
