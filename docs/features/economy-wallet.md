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
- **Launching a capital (join flow).** Capitals cost credits to launch (the
  launch table in `shared-types/launch.ts`; sub-capitals are free). A new
  pilot gets **5 free capital launches**; after those, a launch you can't
  afford goes on credit, taking the wallet **below zero, down to −100,000**.
  In debt you can't buy anything until income pays it off. Past the floor
  you launch in a Fighter. Resuming a hull you own is free. The [Hangar](hangar.md)
  shows each price before Launch (`LAUNCH_COSTS_ON = true`).

## How it works

- **The wallet module.** `src/server/economy/Wallet.ts` keeps one balance per
  canonical playerId, and memory is the authority. API:
  - `credit` / `debit`: all-or-nothing, persisted at once;
  - `creditDeferred` / `debitDeferred` + `putOp`: for moves that must be
    atomic with goods (they return a `WALLET_PUT` op for the caller's
    `HoldStore.commit(…, extraOps)` group);
  - `flush`;
  - `debitAllowingDebt(pid, n, floor)`: the ONLY way below zero (launch on
    credit). Every other debit stays all-or-nothing, and `hydrate` keeps a
    negative balance across a restart.

  Every change is a `wallet_tx` audit event.
- **Launch charging** (`economy/launchCharge.ts` `chargeLaunch`): the server
  side of the shared `launchVerdict`. The SectorRoom hull gate (a fresh, not
  resumed, spawn) and the respawn path both call it: `pay` debits, `token`
  spends a free launch (`EconomyStore` `PlayerEconomy.freeLaunches`, default
  5, via the TradeSink), `debt` uses `debitAllowingDebt`; a refusal downgrades
  to a Fighter with a notice. Each charge is a `launch_charged` audit event.
  The own-ship snapshot carries `freeLaunches` next to `wallet` (Zustand
  `freeLaunches`). Test rooms switch prices on with the `launchCosts` option.
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
  `seedStorageHold.credits`, which now seeds joiners' wallets. The seed lands
  BEFORE the launch is charged, so it pays for it. It works in test rooms and
  wherever the server runs with `EQX_ALLOW_DEV_OVERRIDES=1` (URL
  `?initialWallet=500000`).

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
- `launchCharge.test.ts` (every verdict path, a failed charge refuses),
  `EconomyStore.test.ts` (free launches persist), and
  `tests/integration/sectorRoom/launchCharge.test.ts` (pay, token, debt,
  refuse past the floor, resume free, through a real room).

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Economy v2 W1 — the wallet.** Credits are virtual: never cargo. the GameHud status capsule (testid `wallet-chip` / `data-wallet`) shows the one balance from the Zustand `wallet`, written ONLY from the own-ship snapshot `states[].wallet` field when it changes (#16). Bounty and repair UIs check and pay from the wallet; no storage picker for payment.
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **The wallet — credits are VIRTUAL (economy v2 W1, plan peppy-jumping-pinwheel)**: `economy/Wallet.ts` holds ONE balance per canonical playerId (memory authority; absolute `WALLET_PUT` op; table `player_wallets`; boot `initWallet` AFTER the account merge, then `migrateLegacyHoldCredits`). **Rules:** (1) credits NEVER live in a `Hold` — no pod, ship, storage, escrow or bounty hold carries them, so death / abandon / raze / raids can't touch them; (2) every source pays the wallet (`credit`) and every sink debits it (`debit`, all-or-nothing) — NPC kill bounty (`rollKillBounty`, loot-table `bounty` ranges), elite/mothership bounties, trade sells, PvP bounties; repair/respec/trade buys+gifts/bounty placement; (3) when a credit move must be atomic with goods (trade), use `creditDeferred`/`debitDeferred` and fold the op into the SAME `HoldStore.commit(…, extraOps)` group — on a failed commit, `flush` the restored balance; (4) trade holds wallet-paid credits on the run (`run.paid`) and refunds them on every unwind (raid, abort, reconcile); (5) the own player's balance rides the own active ship's snapshot entry (`wallet`, #16); (6) guests are full players — no sign-in gate on wallet features; (7) testMode `initialWallet` / room `seedStorageHold.credits` seed wallets (never holds). The structures agent's payouts (colonies, Freight Dock) call the same API. Locks: `Wallet.test.ts`, `tests/integration/sectorRoom/walletKillBounty.test.ts`, `TradeDirector.test.ts`. Story: [docs/features/economy-wallet.md](economy-wallet.md).
