# Blueprints (Living World P5)

Phase P5, the last phase of the Living World plan (`peppy-jumping-pinwheel`).
Blueprints are rare loot that permanently improve one ship until it is lost.
They complete the loop: hunt → loot → carry home at risk → bank → upgrade.

## What the player sees

- **Where they drop.** A named elite drops one about 40% of the time; the Drone
  Mothership drops the same haul. A cleared Robot Incursion's cache holds one
  about half the time. Loot pods carrying a blueprint glow gold (top tier).
- **Carrying.** Blueprints are weightless. The cargo chip counts them (★n).
  They spill with the rest of the hold if you die, so bring them home.
- **Banking.** Like any cargo, they auto-deposit at your own storage. The
  storage inspector lists them as **★ Install \<name\>** chips.
- **Installing.** Park your ship within 400 u of that storage and tap the chip.
  The blueprint moves from storage onto your **active ship**, and a toast
  confirms it. One of each kind per ship.
- **Lost with the ship.** If that ship is destroyed or abandoned, its installed
  blueprints are gone.

| Blueprint | Effect |
|---|---|
| **Missile Rack** | A spare hardpoint can carry heat-seeking missiles. Without it, Missile is greyed out in the upgrade screen and the server refuses it. |
| **Cargo Expander** | +50% cargo capacity. |
| **Reinforced Hull** | +25% max hull, at once. The extra starts empty: no free heal. |

## How it works

- **Catalogue:** `src/shared-types/blueprints.ts` (shared, #15) holds the
  catalogue, the weapon gate (`weaponUnlocked`), the multipliers
  (`fittedCargoMul` / `fittedHullMul`), the drop roll and the message schemas.
- **Installed blueprints are a hold.** They live in a `fitted` holder keyed
  `fitted:<shipInstanceId>`. An install is ONE atomic hold group
  (`StorageService.installBlueprint`): the storage loses it and the fitted
  hold gains it. A blueprint is never minted or duplicated, and survives a
  restart like any hold. No roster schema change was needed.
- **Effects are applied in one place each:**
  - **Hull:** `SectorRoom.shipHullMax` (kind base × stat upgrades × fitted) at
    every hull-seed site, and immediately on install.
  - **Cargo:** the loot collector's capacity.
  - **Weapon gate:** `activateMount`.
- **Lost with the ship.** `spillOrLoseShipHold` is the one seam every death and
  abandon path goes through, and it drops the fitted hold.
- **Client state (#16):**
  - The own active ship's fitted list rides `SnapshotMessage.states[].fitted`
    (own-only, sent when non-empty). It drives the cargo chip's capacity and
    the upgrade modal's Missile gate (Zustand `fittedBlueprints`, written only
    on change).
  - Stored blueprint ids reach the owner's storage inspector through the
    owner-only `entity_stats.hold.blueprintIds`.
  - `install_blueprint` → `blueprint_result` (a toast) is an accelerator only.
- **Audit event:** `blueprint_installed`.

## Not yet

- Blueprints can't be bought or sold through trade deals yet; deals move
  goods only.
- No video yet (pending the showcase recording pass).

## Tests

- `tests/integration/sectorRoom/blueprintInstall.test.ts`, a real room with real
  messages:
  - an install moves the blueprint storage → ship, and the client sees `fitted`;
  - hull ×1.25 applies at once;
  - the Missile Rack gate refuses heat-seekers before the install and accepts
    them after;
  - refusals: a duplicate, a blueprint the storage lacks, a ship too far away;
  - death destroys the fitted hold.
- `src/shared-types/blueprints.test.ts`: gates, multipliers, names, drop rates.
- `BlueprintInstall.test.tsx` and `UpgradeModal.test.tsx`: the chips by name,
  the install send, and the Missile lock.
