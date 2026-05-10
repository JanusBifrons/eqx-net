import { Container, Text, TextStyle } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

/**
 * Per-entity text label manager. One small text label appears above every
 * remote ship and every drone:
 *
 *   - Players: `displayName` (or `email`) propagated from the server's
 *     `ShipState.displayName`, with a `Pilot ${id}` fallback for anonymous
 *     joins. The local player's own ship intentionally has no label —
 *     you don't need to be told who you are.
 *   - Drones: `AI XXX` where XXX is the entityId in 3-char zero-padded
 *     uppercase hex. Stable per drone, deterministic from the wire's
 *     entityId; small numbers will look like `AI 001`, `AI 00F`, etc.
 *
 * Modelled on `HealthBarManager`: persistent map keyed by composite id
 * (`p:<playerId>` / `d:<entityId>`), lazy-created Pixi `Text` per entry,
 * repositioned each frame from the mirror's current pose. Sweep removes
 * labels for entities that have left the frame.
 */

/** Pixels above the sprite the label baseline sits at (Pixi screen-space,
 *  i.e. before the renderer's per-frame Y-flip). 28 px clears the ship
 *  hull comfortably without crowding the next sprite up. */
const LABEL_OFFSET_PLAYER = 28;
const LABEL_OFFSET_DRONE = 24;
const LABEL_COLOR_PLAYER = 0xcccccc;
const LABEL_COLOR_DRONE = 0xff8888;

interface LabelEntry {
  text: Text;
  /** Cached value so we only re-set `text.text` when the underlying
   *  string actually changes — that's what triggers Pixi's atlas
   *  upload, which is the expensive part. */
  lastValue: string;
}

/** Format a drone's stable name from its numeric entityId. Exported for
 *  the unit test in `Labels.test.ts`. Pad-3 keeps short numbers visually
 *  uniform without truncating the rare high-id case. */
export function formatDroneName(entityId: number): string {
  return `AI ${entityId.toString(16).toUpperCase().padStart(3, '0')}`;
}

/** Pick the player-facing label string for a remote ship. Exported for
 *  the unit test in `Labels.test.ts`. */
export function formatPlayerLabel(playerId: string, displayName?: string): string {
  if (displayName && displayName.trim().length > 0) return displayName.trim();
  return `Pilot ${playerId.slice(0, 4).toUpperCase()}`;
}

const PLAYER_TEXT_STYLE = new TextStyle({
  fontFamily: 'sans-serif',
  fontSize: 12,
  fontWeight: '600',
  fill: LABEL_COLOR_PLAYER,
  align: 'center',
});
const DRONE_TEXT_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: '700',
  fill: LABEL_COLOR_DRONE,
  align: 'center',
  letterSpacing: 1,
});

export class LabelManager {
  private readonly container: Container;
  private readonly labels = new Map<string, LabelEntry>();
  /** Reused per-frame to avoid allocating a fresh Set every update. */
  private readonly seen = new Set<string>();

  constructor(parent: Container) {
    this.container = new Container();
    // Labels render on top of everything else in this container hierarchy.
    parent.addChild(this.container);
  }

  update(mirror: RenderMirror): void {
    this.seen.clear();
    const localId = mirror.localPlayerId;

    // Players (skip self — own ship gets no label).
    for (const [playerId, ship] of mirror.ships) {
      if (playerId === localId) continue;
      const key = `p:${playerId}`;
      this.seen.add(key);
      const value = formatPlayerLabel(playerId, ship.displayName);
      this.upsert(key, value, ship.x, -ship.y - LABEL_OFFSET_PLAYER, false);
    }

    // Drones — kind === 1. Asteroids skipped.
    if (mirror.swarm) {
      for (const [entityId, sw] of mirror.swarm) {
        if (sw.kind !== 1) continue;
        const key = `d:${entityId}`;
        this.seen.add(key);
        const value = formatDroneName(entityId);
        // Drones (kind=1) render from `sw.x/y` directly post the
        // 2026-05-09 AI lockstep reset (only asteroids need the lerp
        // path), and we've already filtered out asteroids above.
        this.upsert(key, value, sw.x, -sw.y - LABEL_OFFSET_DRONE, true);
      }
    }

    // Sweep: drop labels whose entity has left the frame this update.
    for (const [k, e] of this.labels) {
      if (!this.seen.has(k)) {
        e.text.destroy();
        this.labels.delete(k);
      }
    }
  }

  /** Lazy-create a label entry; reposition; only re-set `.text` when
   *  the underlying string actually changes. `isDrone` picks the
   *  pre-built `TextStyle` so we share style objects across all labels
   *  of the same kind (Pixi caches atlases per style). */
  private upsert(key: string, value: string, x: number, y: number, isDrone: boolean): void {
    let entry = this.labels.get(key);
    if (!entry) {
      const text = new Text({
        text: value,
        style: isDrone ? DRONE_TEXT_STYLE : PLAYER_TEXT_STYLE,
      });
      text.anchor.set(0.5, 1); // bottom-centred above the sprite
      this.container.addChild(text);
      entry = { text, lastValue: value };
      this.labels.set(key, entry);
    } else if (entry.lastValue !== value) {
      entry.text.text = value;
      entry.lastValue = value;
    }
    entry.text.x = x;
    entry.text.y = y;
  }

  destroy(): void {
    for (const entry of this.labels.values()) {
      entry.text.destroy();
    }
    this.labels.clear();
    this.container.destroy({ children: true });
  }
}
