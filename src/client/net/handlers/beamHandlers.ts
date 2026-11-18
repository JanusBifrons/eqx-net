/**
 * Server → client `laser_fired`: feeds the per-shell timing, then upserts a
 * remote shooter's beam into `mirror.remoteLasers` for the renderer.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { LaserFiredEvent } from '@shared-types/messages';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import { findMount, isSustainedBeamMount, remoteBeamTtlMs } from '../../render/beamStyles';

/** What the beam handler touches: the mirror, the client clock and the
 *  `laser_fired` sink (`DrawnShellTiming.onBeamFired`). */
export interface BeamHandlerCtx {
  readonly mirror: RenderMirror;
  readonly now: () => number;
  readonly onBeamFired: (evt: LaserFiredEvent) => void;
}

/** The catalogue mounts of a `laser_fired` shooter's ship kind (a remote
 *  player's ship, or a `swarm-<id>` drone/capital), or undefined when the
 *  shooter isn't mirrored. Same lookup the renderer's beam loop does. */
function shooterKindMounts(mirror: RenderMirror, shooterId: string): readonly WeaponMount[] | undefined {
  const ship = mirror.ships.get(shooterId);
  if (ship) return ship.kind ? getShipKind(ship.kind).mounts : undefined;
  if (!shooterId.startsWith('swarm-')) return undefined;
  const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
  const sw = Number.isNaN(entityId) ? undefined : mirror.swarm?.get(entityId);
  return sw?.shipKind ? getShipKind(sw.shipKind).mounts : undefined;
}

export function registerBeamHandlers(room: Room, ctx: BeamHandlerCtx): void {
  const { mirror, now, onBeamFired } = ctx;

  room.onMessage('laser_fired', (evt: LaserFiredEvent) => {
    onBeamFired(evt);
    // Own shots are already shown as liveBeams — only store remote ones.
    if (evt.shooterId === mirror.localPlayerId) return;
    const dx = evt.toX - evt.fromX;
    const dy = evt.toY - evt.fromY;
    const range = Math.hypot(dx, dy);
    // Upsert: replaces the previous beam from this (shooter, mount) so
    // there is never more than one entry per mount and the TTL resets on
    // each shot. Player beams are HELD weapons (cooldown 167 ms at 60 Hz;
    // TTL 400 ms keeps the visual continuous while space is held).
    //
    // For AI shooters (`swarm-${entityId}`) the iteration we converged on:
    //   - First attempt 400 ms: the beam endpoints were stamped at fire time
    //     and stayed frozen, but the drone moved underneath, so each new
    //     fire teleported the beam origin → "jittery and laggy" (5c smoke).
    //   - Second attempt 80 ms: gave a discrete flash, but cooldown is 167 ms,
    //     so there's an 87 ms gap between flashes → visible flicker.
    //   - Settled: 250 ms TTL (overlaps cooldown by ~83 ms, no gap) AND the
    //     renderer re-derives the beam ORIGIN from `mirror.swarm[entityId]`
    //     each frame so it tracks the moving drone smoothly. Same pattern
    //     player beams use against `mirror.ships[localId]`.
    //
    // Multi-mount/turret refactor (Phase 2c): keyed by (shooterId, mountId).
    // Pre-2c servers omit `mountId`; we synthesise `'forward'` so the entry
    // still has a stable key and legacy single-mount rendering is unchanged.
    const isAiShooter = evt.shooterId.startsWith('swarm-');
    const mountKey = evt.mountId ?? 'forward';
    // The capital heavy beam (cooldown 10 ticks) holds longer so it reads as
    // one continuous burn, not a strobe (beamStyles `remoteBeamTtlMs`). Its
    // mount is looked up on the shooter's kind: no wire field.
    const ttlMs = remoteBeamTtlMs(isAiShooter, isSustainedBeamMount(findMount(shooterKindMounts(mirror, evt.shooterId), evt.mountId)));
    const lasers = (mirror.remoteLasers ??= new Map());
    let perShooter = lasers.get(evt.shooterId);
    if (!perShooter) {
      perShooter = new Map();
      lasers.set(evt.shooterId, perShooter);
    }
    // 2026-05-25 heap-growth gate step 7: pool the per-fire entry.
    // Pre-fix this handler allocated a fresh 8-field object literal
    // per drone fire (~150 allocs/sec under 25-drone combat).
    // Isolation experiment 2026-05-25 showed the 3 message handlers
    // (swarm/damage/laser_fired) drive 0.435 MB/s heap growth +
    // 80% of major-GC stalls. Reusing the entry object per
    // (shooter, mount) is safe — the renderer reads fields
    // synchronously each frame; upsert semantics are preserved.
    const expiresAt = now() + ttlMs;
    const existing = perShooter.get(mountKey);
    if (existing) {
      existing.range = range;
      existing.hit = evt.hit;
      existing.targetId = evt.targetId;
      existing.expiresAt = expiresAt;
      existing.fromX = evt.fromX;
      existing.fromY = evt.fromY;
      existing.toX = evt.toX;
      existing.toY = evt.toY;
    } else {
      perShooter.set(mountKey, {
        range,
        hit: evt.hit,
        targetId: evt.targetId,
        expiresAt,
        fromX: evt.fromX,
        fromY: evt.fromY,
        toX: evt.toX,
        toY: evt.toY,
      });
    }
  });
}
