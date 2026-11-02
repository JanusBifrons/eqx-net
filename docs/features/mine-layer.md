# Mine Layer

A defence structure that seeds a base's approaches with proximity mines (plan soft-leaping-truffle v3; "Mine Layers use munitions per mine").

## What the player sees

- **Build it** from the Defence category (it is placed from a packed item, made at a Fabricator).
- **When it is built, powered and stocked,** it lays a mine every 8 s on a ring 420–760 u around itself, until it has six out. Each mine is a small canister with a blinking light and a faint trigger ring: cyan for your mines, red for anyone else's. The ring is a warning: you can see a minefield before you fly into it.
- **A mine arms 2 s after it is laid,** then goes off on the first ship **hostile to its owner** that comes within 110 u. The blast deals 260 damage to that ship and shows the missile explosion.
- **Who counts as hostile** is the owner's turret rule:
  - for a player's base, drones and any pilot who committed a hostile act against them (a break-in, an attack);
  - for an NPC base, anyone hostile by relation.
  You can fly through your own minefield, or a neutral base's, safely.
- **It costs munitions:** one unit of munitions lays two mines. With none in base storage the layer stops and shows "no munitions". It draws full power only while laying.
- **Mines go with their layer.** Destroy or deconstruct the layer and its mines vanish.
- **NPC strongholds and citadels** build one or two layers (`BASE_GROWTH_VERSION` 5).

## How it works

- **Constants** live in `src/shared-types/mines.ts` (shared by both sides, #15).
- **Server.** `src/server/structures/MineFieldSubsystem.ts` holds decision logic over injected hooks and is ticked with the 10 Hz structure tick, after the turrets.
  - It uses the turrets' target grids (`findNearestTurretTarget`).
  - It shares the turrets' magazine field (`rec.ammo`, `AMMO_SHOTS_PER_UNIT.mine_layer`).
  - It uses the same active-power switch (`setActive`).
  - Spots are chosen by the golden angle round the ring, skipping any spot within 90 u of a structure, asteroid or other mine, or the sector edge (`SectorRoom.mineSpotClear`).
- **Wire.** Mines are static, so they live in **room state**: `SectorState.mines`, a `MineState { ownerIdx, x, y }` keyed by mine id. The join payload has every mine; laying or detonating one is one patch (#16). `mine_detonated` is only an accelerator for the blast visual.
- **Client.** `ColyseusClient.syncMines` mirrors room state into `mirror.mines` in place, and `ConnectorRenderer.drawMines` draws them on the per-frame layer.
- **Not persisted.** Mines are laid again after a restart.

## Tests

- `src/server/structures/MineFieldSubsystem.test.ts`:
  - laying, the ring and the cap;
  - the munitions magazine;
  - unpowered layers;
  - blocked spots;
  - arming;
  - hostile-only triggering;
  - removal with the layer.
- `tests/integration/sectorRoom/mineLayer.test.ts` (real room):
  - a mine is laid from munitions and appears in room state;
  - an armed mine goes off on a drone, which every client sees as a hit and a blast, and the mine leaves room state;
  - a friendly pilot parked on a mine is safe;
  - mines leave with the layer.
- `growBase.test.ts`: only strongholds and citadels mine their approaches.
