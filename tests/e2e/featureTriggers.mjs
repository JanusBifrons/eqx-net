/**
 * Path-triggered feature specs (test audit 2026-11-06, plan prancy-squishing-donut P4).
 *
 * CI runs only the smoke tier on every PR; feature specs used to run only when
 * someone ran `pnpm e2e` locally, which is how ~30 of them rotted unnoticed.
 * A PR that touches an area below also runs that area's feature specs (the
 * `e2e-feature-affected` CI job). A changed feature spec always runs itself.
 *
 * Plain JS so the CI job can run the selector without a TS toolchain.
 * Area paths are prefixes (no globs). Specs are names under tests/e2e without
 * `.spec.ts`. Add an area when you add specs that guard it.
 */
export const FEATURE_TRIGGERS = [
  {
    area: 'structures',
    paths: ['src/server/structures/', 'src/core/structures/', 'src/client/structures/', 'src/shared-types/structureKinds',
      'src/client/components/StructurePlacementBanner', 'src/client/components/SpeedDialMenu', 'src/client/components/buildCategories',
      'src/client/render/pixi/ConnectorRenderer'],
    specs: ['structure-build-placement', 'structure-grid-web', 'structure-placement-ghost', 'structure-scenario', 'structure-mining-beam',
      'structure-ram-blocked', 'structure-turret-range', 'structure-visible-damageable', 'speed-dial', 'gate-fly-through'],
  },
  {
    area: 'spectator and ship switching',
    paths: ['src/client/spectator/', 'src/client/components/PilotSpectatorToggle', 'src/client/net/snapshotShipRouter', 'src/client/ships/'],
    specs: ['spectator-mode'],
  },
  {
    area: 'energy and boost',
    paths: ['src/core/combat/Energy', 'src/client/hud/GameHud', 'src/client/hud/widgets', 'src/core/physics/applyShipInput'],
    specs: ['energy-bar', 'boost-facing'],
  },
  {
    // Lock-to-fire (universal 2026-11-09): a group fires only at a completed lock.
    area: 'fire control and combat',
    paths: ['src/server/rooms/LockSubsystem', 'src/server/rooms/NpcLockSubsystem', 'src/server/rooms/PlayerFireResolver',
      'src/core/combat/lock', 'src/shared-types/combat/lockProfile', 'src/client/hud/WeaponStrip', 'src/client/components/TargetAction',
      'src/client/input/MouseLock', 'tests/e2e/helpers/fireControl'],
    specs: ['lock-to-fire-default', 'fire-control-lock', 'auto-fire', 'auto-fire-multitouch', 'fx-weapons', 'drone-destruction'],
  },
  {
    area: 'beams',
    paths: ['src/client/render/BeamSpritePool', 'src/client/combat/'],
    specs: ['laser-smoothness', 'laser-falloff-probe'],
  },
  {
    area: 'galaxy map',
    paths: ['src/client/render/galaxy/', 'src/client/components/Galaxy', 'src/client/components/SectorInfoDrawer', 'src/client/app/galaxyOverlay',
      'src/client/app/useGalaxy'],
    specs: ['galaxy-sector-drawer', 'galaxy-map-pan-zoom', 'galaxy-hover-tooltip', 'galaxy-living-map', 'galaxy-landing-reveal',
      'galaxy-sector-badge-icon-label', 'galaxy-sector-transit-adjacency', 'galaxy-map-no-warp-ripple'],
  },
  {
    area: 'off-screen radar',
    paths: ['src/client/render/halo/', 'src/client/render/HaloRadar'],
    specs: ['radar-sandbox', 'ring-indicator-dead-zone', 'ring-indicator-mobile-scaling'],
  },
  {
    area: 'teleporters and trade',
    paths: ['src/server/structures/TeleporterSubsystem', 'src/client/components/TeleporterPanel', 'src/server/economy/', 'src/client/layout/Drawer/tabs/TradeTab'],
    specs: ['teleporter', 'trade-tab', 'break-in'],
  },
];

/**
 * Feature specs known to fail (see docs/refactors/test-coverage-audit.md,
 * 2026-11-06). They are skipped by the selector until fixed, so a PR that
 * touches their area is not blocked by an old failure. Remove an entry in the
 * PR that fixes it.
 */
export const QUARANTINE = new Set([
  // 2026-11-09 6x re-run (lane 1000, lock-to-fire universal); machined-art
  // went 6/6 and left the list. Still red, each without a quick fix:
  //
  // held-fire test (:415) 0/5: one salvo per hold, never a cooldown
  // rollover (heat-seeker cooldown 90 ticks; energy is not the limit). The
  // other five tests in the file pass 5/5.
  'missile-frigate-homing',
  // 0/6: the fighter's AUTO group locks the gate (chip data-locked=1 with
  // instantLock) but fires no bolts (fxProjectiles stays 0 for 10 s), so the
  // fence never ripples. Is AUTO fire held against a locked non-hostile
  // structure?
  'fence-hits',
  // auto-fire test (:68) 0/5: the gunship kills the hostile drone in about
  // 3 s, before its Machined turrets are drawn (turrets is 0 until about 4 s,
  // even after the warm-up join), so turretShots never counts. Needs a way to
  // join with the groups in MAN and switch to AUTO once the guns are drawn
  // (no `groupMode` join option yet). The other three tests pass 5/5.
  'fx-turrets',
]);
