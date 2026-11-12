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
      'src/client/components/BottomControlPanel', 'src/client/net/snapshotRemoteSync', 'src/client/net/displayMountAngles'],
    specs: ['spectator-mode', 'build-hotbar-fits-viewport', 'spectator-npc-turrets'],
  },
  {
    // Capital helm orders + the green move marker at the course point.
    area: 'capital helm',
    paths: ['src/core/helm/', 'src/client/helm/', 'src/client/render/helm/', 'src/client/components/HelmPanel'],
    specs: ['capital-helm'],
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
  // 2026-11-12: homing, swarm damage, held fire (its rolled-ring read fixed)
  // and impact-only all pass on CI now. Only the touch chip hold (:650)
  // times out at 90 s on CI's host, though it went 6/6 on the desktop.
  'missile-frigate-homing',
  // 2026-11-12 desktop 3x re-run (lane 520): structure-placement-ghost,
  // speed-dial, fire-control-lock, laser-falloff-probe, multiple-lingering-pool
  // and spawn-swap-lingers went 3/3 and left the list (the PR that released
  // them ran them on CI: a spec leaving the list runs itself), as did
  // interceptor-beam-stays-connected, a test bug: its beam destroys the drone
  // at ~0.85 s, so it now judges the beam-on frames), and
  // prediction-idle-bounded (a test bug: it counted the corrections made
  // behind the loading curtain, where prediction doesn't step; it now counts
  // from the lift), and scrap-collision-stress: below ~15 fps the client
  // jumps to keep up (recoverInputTickFromStarvation), which the owner accepts
  // as expected on a device that slow (2026-11-12), so the spec now skips when
  // the host draws < 15 fps during the flight and gates prediction otherwise.
  //
  // Back on the list (CI run 43248949740, shard 1): these four pass on the
  // desktop but time out on CI's software-GL runner, on all three tries.
  // Not yet probed there; each needs a CI-host repro (failure traces now
  // upload, #485) before it can leave again.
  'fire-control-lock', // :115 hands-off LOCK then CANCEL: 60 s timeout.
  'laser-falloff-probe', // :83 hit beam: timeout.
  'interceptor-beam-stays-connected', // :142 beam origin while coasting: 90 s timeout.
  'prediction-idle-bounded', // :117 sub-snapshot poses while coasting: timeout.
  // Same pattern on shard 2 of the re-run (43253336850).
  'speed-dial', // :197 dial stays open across a placement.
  'structure-placement-ghost', // (A) :94, (C) :158, (G) :368 ghost tracking.
]);
