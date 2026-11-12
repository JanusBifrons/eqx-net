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
    paths: ['src/client/spectator/', 'src/client/components/PilotSpectatorToggle', 'src/client/net/snapshotShipRouter', 'src/client/ships/',
      'src/client/components/BottomControlPanel'],
    specs: ['spectator-mode', 'build-hotbar-fits-viewport'],
  },
  {
    // Game time scale (stream/time-scale): per-sector speed, the snapshot keyframe and the HUD chip.
    area: 'game time scale',
    paths: ['src/core/clock/GameClock', 'src/server/time/', 'src/client/hud/GameHud', 'src/client/net/swarmInterpolation'],
    specs: ['time-scale-chip'],
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
      'src/client/input/MouseLock', 'tests/e2e/helpers/fireControl', 'src/client/components/ContactsOverview',
      'src/client/components/contactRows'],
    specs: ['lock-to-fire-default', 'fire-control-lock', 'contacts-overview', 'auto-fire', 'auto-fire-multitouch', 'fx-weapons', 'drone-destruction'],
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
  // 2026-11-12: missiles and bolts now step by WORKER ticks; homing, swarm
  // damage and held fire went 6/6. Still red: impact-only, from host load
  // (:557, 0/6) waits lifetime + 3 s for the expiry, but the loaded server's
  // physics worker ran at ~34 Hz (every room shares it), so the 6 s lifetime
  // took 10.6 s (probe). The touch chip hold (:646, 1/6): not yet probed.
  'missile-frigate-homing',
  // 2026-11-10: failing on CI's e2e-feature-affected since lock-to-fire went
  // universal (#385). Parked by the user for a pass next week: check each is
  // still relevant, then fix or retire it. CI runs 42674277690, 42694505833,
  // 42694522168. Notes from a first look:
  //
  // A-K time out or the worker drag stalls; #398 didn't cure it on CI.
  'structure-placement-ghost',
  // :197 repeat builds across a placement (R2.6); new on train #399.
  'speed-dial',
  // :115 hands-off LOCK then CANCEL in the info box; the drain case is flaky.
  'fire-control-lock',
  // :106 hit beam; :77 is already fixme (no firing into empty space now).
  'laser-falloff-probe',
  // :142 beam origin while coasting: 16 of 40 coast frames active, wants > 20.
  'interceptor-beam-stays-connected',
  // An observer sees lingering hulls; flaky on #399 and #402.
  'multiple-lingering-pool',
  'spawn-swap-lingers',
  // Idle prediction sub-pixel in feel-test-25; flaky on #399 and #402.
  'prediction-idle-bounded',
  // Cause known (2026-11-09): below ~15 fps the client jumps inputTick ahead
  // without stepping the ship (recoverInputTickFromStarvation), then snaps.
  // Fix options a/b/c are in the consolidated handoff; they wait for a phone run.
  'scrap-collision-stress',
]);
