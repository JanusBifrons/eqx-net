# Trade deals (Living World P2)

How trading works for the player. Internals:
[docs/architecture/economy-and-trade.md](../architecture/economy-and-trade.md).

## The short version

There are no trade stations. Open the **Trade** tab in the sidebar, pick an
offer, and agree a deal. A trader **hauler** flies to your base, docks for a
short while, and leaves. Nothing changes hands until it leaves safely, so if
something shoots it down on the way in or while it is docked, the deal fails.

## The Trade tab

- **Standing** with the three AI sides — drones, robots, traders — as bars from
  Hostile to Allied.
- **Trade from** — which of your storage structures (Capital, Cargo Bay) in this
  sector the deal uses. Connected storage counts as one network.
- **Offers** — the current board. Prices move with supply (selling a lot of one
  good pushes its price down) and your trader standing shifts them by up to
  15 %. Tap **Deal** to choose:
  - quantity (up to the offer's limit);
  - **one-off**, or **every 10 / 30 / 60 minutes** for a number of visits;
  - for recurring deals, a **price band**: a visit is skipped if the price has
    moved further than that since you agreed.
- **Deals** — each deal's state (scheduled, inbound, docked, departing,
  settled, failed) and its next visit. **Cancel** is free between visits; during
  a visit the deal ends after it.
- **History** — what happened, newest first.

> **Economy v2 W4b — packed structures.** The board also carries a rotating
> handful of **Buy Packed \<structure\>** offers (1–3 each). Price: the pack
> recipe's goods value × 1.3, shifted by your trader standing like goods.
> They are one-off deals. The hauler carries the packed structures in its hold
> (a raid spills them as a pod) and unloads them into your storage when it
> leaves. You need one to place any non-starter structure; see
> [blueprints.md](blueprints.md).
> **Economy v2 W1:** credits are a virtual wallet ([economy-wallet.md](economy-wallet.md)).
> A buy's price and a gift's credits are taken from your wallet when the
> hauler docks and refunded to it if the visit fails; a sale's proceeds land in
> your wallet when the hauler leaves safely.

- **Gift** — send goods or credits to any side for standing. Giving a lot at
  once buys less standing per credit.

The rail icon shows a red badge for news you haven't seen.

## A visit

1. The hauler appears at the edge of the sector and flies to your base.
2. It docks beside your storage: your side of the trade moves into escrow (the
   goods you sell go into its hold; the credits for a purchase are set aside).
3. After about 20 seconds it spools up and leaves (about 8 seconds).
4. When it has left: a sale pays you (minus a 5 cr hauling fee); a purchase
   delivers the goods into your storage.

A visit is **skipped** (and retried later) when your base is under attack, your
storage is gone, traders refuse you, or there is nothing to trade. If the base
holds less than the deal asks for, the visit fills partially (small standing
cost).

Deals keep running while you are offline. When you come back, a **While you were
away** summary lists what happened.

## Danger

- **Robots raid haulers.** When anything shoots your hauler, a red toast says
  it is under fire — that is your cue to fly out and escort it. Tap the toast to
  open the Trade tab.
- If the hauler is destroyed, its hold spills as loot pods where it died. On a
  sale that is your goods; on a purchase it is the trader's goods. Credits you
  had set aside for a purchase or gift come back to your storage.
- **Piracy:** any player who damages a hauler loses trader standing. If you
  shoot your OWN hauler, you also forfeit the escrow.

## Standing

| Side | What standing does |
|---|---|
| Traders | Better prices (up to 15 %); below a point they refuse you. |
| Robots | At "Allied" robots stop attacking you on sight (attacking one costs standing). |
| Drones | Good standing makes waves against your base rarer (up to 3× apart). |

Standing comes from completed deals and from gifts.

## Limits

- 3 active deals per base.
- About 20,000 credits of goods traded per hour.
- Trading needs a signed-in account.
