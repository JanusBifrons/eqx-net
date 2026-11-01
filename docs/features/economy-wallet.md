# The wallet: credits are virtual (economy v2 W1)

Plan `peppy-jumping-pinwheel`, economy v2, phase W1. This follows Eve Online:
**credits are conceptual, not physical.**

## What the player sees

- **One balance per player**, shown on the HUD wallet chip (`¢ 12,345`, top-left,
  under the cargo chip) and at the top of the Trade tab.
- **Earning credits.** The wallet is credited automatically:
  - every NPC you destroy pays a **kill bounty** (its kind's bounty range,
    for example 8–20¢ for a robot cube and 400–800¢ for the nexus);
  - named elites (300¢) and the Drone Mothership (500¢) pay their bounty;
  - player bounties on someone you destroy;
  - goods you sell to traders.
- **Spending credits.** The wallet is debited automatically, from anywhere:
  - repairs at your own storage;
  - stat respecs;
  - trade buys and gifts;
  - placing bounties.
- **Credits are never cargo.** Loot pods, ship holds and storage carry goods
  and blueprints only. **You can't drop, spill, lose or be robbed of
  credits**: dying, abandoning a ship, a razed base or a harvester raid never
  touches your balance.
- **Guests are full players.** A guest is an account that hasn't set a
  password, so it has a wallet like anyone else.

## How it works

- **The wallet module.** `src/server/economy/Wallet.ts` keeps one balance per
  canonical playerId, and memory is the authority. API:
  - `credit` / `debit`: all-or-nothing, persisted at once;
  - `creditDeferred` / `debitDeferred` + `putOp`: for moves that must be
    atomic with goods (they return a `WALLET_PUT` op for the caller's
    `HoldStore.commit(…, extraOps)` group);
  - `flush`.

  Every change is a `wallet_tx` audit event.
- **Persistence.** Table `player_wallets(player_id, balance)`, written by an
  absolute `WALLET_PUT` op through both writers (`economySql.ts`). It is
  hydrated at boot after the account merge, so alias ids fold onto the
  account's id.
- **One-time migration.** On boot, credits that pre-wallet hold rows carried
  move to their owner's wallet (`economy/walletMigration.ts`), one atomic
  group per row. Ownerless pod credits vanish. An old bounty escrow row is
  refunded to its placer. The migration is idempotent.
- **`Hold` has no `credits`.** `parseHoldJson` drops the field from old rows;
  `legacyHoldCredits` reads it once for the migration.
- **Trade** (`TradeDirector`):
  - A buy's price or a gift's credits are debited at dock, held virtually
    on the run (`run.paid`), and refunded through the wallet if the visit
    unwinds (raid, abort, restart).
  - A sell's proceeds are credited at departure.
  - Each wallet op rides the same atomic group as the deal state.
  - Planning reads the wallet balance.
- **Bounties** (`BountyBoard`): placement is a wallet debit (amount + burned
  fee); the board is a persisted `economy_state` record written in the same
  group; a claim is a wallet credit.
- **Client (#16).**
  - The own active ship's snapshot entry carries `wallet` (the balance). The
    client writes it to Zustand only when it changes.
  - `loot_collected`, `cargo_deposited` and `entity_stats.hold` carry no
    credits.
- **Tests** set credits with the `initialWallet` join option, or a room's
  `seedStorageHold.credits`, which now seeds joiners' wallets.

## Tests

- `src/server/economy/Wallet.test.ts`: credit and debit rules, deferred ops,
  hydrate, and the migration (one group per row, idempotent).
- `tests/integration/sectorRoom/walletKillBounty.test.ts`: a real kill pays
  the killer's wallet, pods carry no credits, the snapshot carries the
  balance, and NPC-on-NPC kills pay nobody.
- `TradeDirector.test.ts`: the wallet pays at dock, refunds on a raid,
  forfeits on a self-raid, sell proceeds land at departure, a short wallet
  never docks, and a restart refunds.
- `BountyBoard.test.ts`, `playerBounty.test.ts`: bounties via the wallet.
- `lootLoop.test.ts`: death spills goods but never touches the wallet.
- `storageDeposit.test.ts`: repair is paid from the wallet, and a short
  wallet is refused.
- `WalletChip.test.tsx`.
