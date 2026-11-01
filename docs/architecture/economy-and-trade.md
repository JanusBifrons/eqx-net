# Economy and trade deals (Living World P2)

Plan: `peppy-jumping-pinwheel`. Builds on holds and storage (P1a,
[docs/features/loot-and-cargo.md](../features/loot-and-cargo.md)) and the
allegiances (P0, [allegiances.md](allegiances.md)).

## The idea

There are **no trader stations**. A player accepts a deal from the offers
board; a trader **hauler** physically flies to the player's base, docks, and
leaves. Both sides sit in escrow while it is docked, and value changes hands
only when it departs safely. Anyone can shoot it down on the way: robots raid
haulers, and players can pirate them at a reputation cost.

## Pieces

| Piece | Where | Role |
|---|---|---|
| Contract | `src/shared-types/economy.ts` | Prices, rep thresholds, deal/offer/view types, zod messages. Shared by client + server (#15). |
| Market | `src/core/economy/market.ts` | One galaxy market. Supply index per good (credits of value); fills move prices; mean reversion + random walk. |
| Reputation | `src/core/economy/reputation.ts` | Per player, per side (drones / robots / traders). Gifts have diminishing returns. |
| Deal rules | `src/core/economy/deals.ts` | `planVisit` (skip reasons, partial fills, price band), `afterVisit` (recurrence + retries), proceeds/cost. |
| Store | `src/server/economy/EconomyStore.ts` | In-memory authority; absolute upserts to `player_economy`, `trade_deals`, `economy_state`. |
| Director | `src/server/economy/TradeDirector.ts` | Offers board, requests, the per-visit state machine, raids, boot reconcile. |
| Room hooks | `SectorRoom` (`TradeRoom`) | `tradeSnapshot`, `tradeTransfer`, `tradeBaseUnderAttack`, `tradeDropAt`, `tradeNotify`, plus the existing bot spawn/move hooks. |
| Storage | `StorageService.tradeSnapshot / tradeTransfer` | The network's tradable stock, and the ONE atomic escrow primitive. |

## A visit

```
scheduled ──planVisit──▶ inbound ──arrives──▶ docked ──dockMs──▶ departing ──departMs──▶ settled
     ▲                       │                   │                   │
     └── skipped (retry) ◀───┘ killed: RAIDED ◀──┴───────────────────┘
```

- **Plan** skips the visit when the base has no storage, is **under attack**
  (an active wave, or any of the owner's structures hit in the last 60 s),
  traders refuse the player (rep < −300), a recurring re-quote leaves the
  player's price band, or nothing can trade. One-off deals retry every 5 min
  (6 attempts); recurring deals simply wait for their next slot.
- **Inbound:** a `trader-hauler` spawns at the sector edge and flies to a dock
  point beside the network's storage. A BUY's goods ride in the hauler's hold
  from spawn.
- **Docked (escrow):** the player's side moves out of the network — a SELL's
  goods into the hauler's hold, a BUY's credits (cost + fee) or a GIFT into an
  `escrow-<run>` hold. A shortfall fills partially (small rep hit).
- **Settled (safe departure):** a SELL's goods leave with the hauler and the
  proceeds (minus the hauling fee) are minted into the network; a BUY's goods
  are released into the network (overflow spills as a pod at the storage) and
  the escrowed credits leave the economy; a GIFT's escrow leaves and buys
  standing with its recipient side.
- **Raided:** the room's kill path spills the hauler's hold where it died (any
  NPC carrying a hold spills it). The player's escrow is refunded — unless the
  owner damaged their own hauler during the run (forfeit, −500). Every player
  who damaged it loses 200 trader standing.

## Atomicity (the anti-duplication contract)

Every value move of a visit is one `StorageService.tradeTransfer` call, which is
one `HoldStore.commit` — one `GROUP` op applied in a SAVEPOINT. The deal's new
state (`TRADE_DEAL_PUT`) rides **inside the same group** (`HoldStore.commit`'s
`extraOps`), so escrow and deal state can never disagree after a crash.

**Restart:** haulers are not persisted. `TradeDirector.reconcile()` (boot,
before `start`) unwinds every in-flight run: escrow goes back to the network,
a docked SELL's goods come back out of the hauler hold, a BUY's trader goods are
discarded, and the visit is rescheduled 30 s later.

## Reputation effects

| Side | Effect |
|---|---|
| Traders | ±15 % on deal prices; below −300 they refuse new deals and visits. |
| Robots | At ≥ 500 robots stop attacking you on sight (`AiPlayerView.truce`, and the room's single `npcHostileTo` query for snapshot hostility / live counts / missile homing). Hitting a robot costs 100 (throttled 10 s), which ends a truce. Retaliation still applies. |
| Drones | Positive standing spaces waves out, up to 3× (`WaveDirector` dispatch spacing). |

Standing is earned by completed deals (+10) and by **gifts** (any side; value
/ 10, halved per 2,000 recently gifted, capped at 150 per gift).

## Limits and sinks

- 3 active deals per base network; offers cap per deal; 20,000 credits of goods
  traded per player per hour (wash-trading defence, alongside prices moving on
  every fill and the 10 % spread).
- Hauling fee of 5 credits per run; the spread; escrowed credits leaving on a buy.

## Client surface

- `GET /trade/offers?playerId=` — the board at the player's prices.
- `GET /trade/economy?playerId=` — standing, deals, history, `econVersion`.
  The Trade tab rebuilds from this (#16); `trade_notice` messages only
  accelerate it.
- Messages: `accept_offer`, `cancel_deal`, `send_gift` (signed-in accounts,
  galaxy sectors only).
- Never create a top-level `src/client/trade/` directory: it would collide with
  the `/trade` Vite proxy (locked by `clientDirProxyCollision.test.ts`).

## Tests

- `src/core/economy/economy.test.ts` — market, reputation, planVisit, afterVisit.
- `src/server/economy/TradeDirector.test.ts` — sell, buy, raid refund, self-raid
  forfeit, sell raided, under-attack skip, recurrence, restart reconcile, escrow
  + deal in one group, deal cap.
- `tests/integration/sectorRoom/tradeDeal.test.ts` — real room: sell settles and
  the hauler leaves; buy raided while docked spills cargo, refunds the buyer,
  and costs the pirate standing.
- `HostileDroneBehaviour.allegiance.test.ts` — robot truce + retaliation.
