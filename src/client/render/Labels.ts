import { Container, Text, TextStyle } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { fnv1a32 } from '@core/random/rng';
import { isOwnedByMe, isParkedHull } from './shipOwnership.js';
import { moveKey } from './shipRekey.js';

/**
 * Per-entity text label manager. One small text label appears above every
 * remote ship and every drone:
 *
 *   - Players: `displayName` (or `email`) propagated from the server's
 *     `ShipState.displayName`, with a plain `Pilot` fallback (NEVER any part of
 *     the id — no ids in the UI) for the rare pre-sync / edge case. The local
 *     player's own ship intentionally has no label — you don't need to be told
 *     who you are; nor does any of your own fleet (friendly ships carry no
 *     label, RTS Part A). A ship an AI pilot flies gets the AI pilots'
 *     callsign (`formatAiShipCallsign`), drone style.
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
const LABEL_COLOR_ELITE = 0xffc850;

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

/** The AI pilots' callsign for a ship an AI pilot flies (RTS Part A): the
 *  drone form `AI XXX`, XXX a stable 3-hex hash of its key (a hull's key is a
 *  uuid, never shown). Exported for `Labels.test.ts`. */
export function formatAiShipCallsign(key: string): string {
  return `AI ${(fnv1a32(key) & 0xfff).toString(16).toUpperCase().padStart(3, '0')}`;
}

/** Pick the player-facing label string for a remote ship. Exported for
 *  the unit test in `Labels.test.ts`. */
export function formatPlayerLabel(playerId: string, displayName?: string): string {
  if (displayName && displayName.trim().length > 0) return displayName.trim();
  // No ids in the UI: every player has a display name, so this fallback is a
  // pre-sync / edge safety net only — a plain "Pilot", never a slice of the id.
  void playerId;
  return 'Pilot';
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

/** P4a — a named elite's label: the name, starred, in gold. */
const ELITE_TEXT_STYLE = new TextStyle({
  fontFamily: 'sans-serif',
  fontSize: 13,
  fontWeight: '800',
  fill: LABEL_COLOR_ELITE,
  align: 'center',
  letterSpacing: 1,
});

type LabelStyle = 'player' | 'drone' | 'elite';
const STYLES: Record<LabelStyle, TextStyle> = {
  player: PLAYER_TEXT_STYLE,
  drone: DRONE_TEXT_STYLE,
  elite: ELITE_TEXT_STYLE,
};

/** The label for a named elite. Exported for `Labels.test.ts`. */
export function formatEliteLabel(name: string): string {
  return `★ ${name}`;
}

export class LabelManager {
  private readonly container: Container;
  private readonly labels = new Map<string, LabelEntry>();
  /** Reused per-frame to avoid allocating a fresh Set every update. */
  private readonly seen = new Set<string>();
  /** `p:<key>` label keys and AI callsigns, built once per ship (#14). */
  private readonly shipKeys = new Map<string, string>();
  private readonly callsigns = new Map<string, string>();

  /**
   * @param showDroneLabels NPC callsigns (`AI 00F`). Off for showcase capture
   *   (`?cleanworld=1`) — player name labels always render.
   */
  constructor(
    parent: Container,
    private readonly showDroneLabels = true,
  ) {
    this.container = new Container();
    // Labels render on top of everything else in this container hierarchy.
    parent.addChild(this.container);
  }

  /** RTS Part A seamless hand-over: the ship's key changed; its label (and
   *  glyph atlas) moves with it. A stale label under `to` is destroyed. */
  rekey(from: string, to: string): void {
    // Rare (a hand-over), never per frame: the two key strings are fine.
    const stale = moveKey(this.labels, `p:${from}`, `p:${to}`);
    stale?.text.destroy({ texture: true, textureSource: true });
  }

  update(mirror: RenderMirror): void {
    this.seen.clear();
    const localId = mirror.localPlayerId;

    // Ships, ACTIVE and LINGERING (#17). RTS Part A owner decision: friendly
    // ships carry no label: the ship you fly and your own fleet (the only
    // ships the client can call friendly; alliances have no client carrier
    // yet). A ship an AI pilot flies (`isParkedHull`) follows the AI pilots'
    // rule: an `AI XXX` callsign in the drone style, off with NPC callsigns.
    // Another pilot's ship keeps its name. TODO: labels configurable.
    for (const [key0, ship] of mirror.ships) {
      if (key0 === localId || isOwnedByMe(mirror, key0, ship)) continue;
      // Phase 4 warp travel: a ship on its warp run is out of the world.
      if (ship.warp === 2) continue;
      const aiFlown = isParkedHull(mirror, key0, ship);
      if (aiFlown && !this.showDroneLabels) continue;
      let key = this.shipKeys.get(key0);
      if (key === undefined) { key = `p:${key0}`; this.shipKeys.set(key0, key); }
      this.seen.add(key);
      if (aiFlown) {
        let callsign = this.callsigns.get(key0);
        if (callsign === undefined) { callsign = formatAiShipCallsign(key0); this.callsigns.set(key0, callsign); }
        this.upsert(key, callsign, ship.x, -ship.y - LABEL_OFFSET_DRONE, 'drone');
      } else {
        this.upsert(key, formatPlayerLabel(key0, ship.displayName), ship.x, -ship.y - LABEL_OFFSET_PLAYER, 'player');
      }
    }

    // Drones — kind === 1. Asteroids skipped. A named elite (P4a) is always
    // labelled, even when NPC callsigns are off (showcase capture).
    if (mirror.swarm) {
      for (const [entityId, sw] of mirror.swarm) {
        if (sw.kind !== 1) continue;
        const elite = sw.eliteName;
        if (elite === undefined && !this.showDroneLabels) continue;
        const key = `d:${entityId}`;
        this.seen.add(key);
        const value = elite !== undefined ? formatEliteLabel(elite) : formatDroneName(entityId);
        // Drones (kind=1) render from `sw.x/y` directly post the
        // 2026-05-09 AI lockstep reset (only asteroids need the lerp
        // path), and we've already filtered out asteroids above.
        this.upsert(key, value, sw.x, -sw.y - LABEL_OFFSET_DRONE - (elite !== undefined ? 10 : 0), elite !== undefined ? 'elite' : 'drone');
      }
    }

    // Sweep: drop labels whose entity has left the frame this update.
    for (const [id, k] of this.shipKeys) {
      if (!this.seen.has(k)) {
        this.shipKeys.delete(id);
        this.callsigns.delete(id);
      }
    }
    for (const [k, e] of this.labels) {
      if (!this.seen.has(k)) {
        // Pixi v8 Text owns its own dynamic glyph atlas (a Texture +
        // TextureSource + WebGLTexture chain). `.destroy()` without
        // `{ texture: true, textureSource: true }` tears down the
        // container but LEAKS the GPU resources. Heap snapshot diff
        // 2026-05-31 showed 84 unleaked Texture chains over 60 s of
        // combat, with `swarm_near_exit: 41` + damage-number bucket
        // evictions matching the count 1:1. Pass full disposal here.
        e.text.destroy({ texture: true, textureSource: true });
        this.labels.delete(k);
      }
    }
  }

  /** Lazy-create a label entry; reposition; only re-set `.text` when
   *  the underlying string actually changes. `isDrone` picks the
   *  pre-built `TextStyle` so we share style objects across all labels
   *  of the same kind (Pixi caches atlases per style). */
  private upsert(key: string, value: string, x: number, y: number, style: LabelStyle): void {
    let entry = this.labels.get(key);
    if (!entry) {
      const text = new Text({
        text: value,
        style: STYLES[style],
      });
      text.anchor.set(0.5, 1); // bottom-centred above the sprite
      this.container.addChild(text);
      entry = { text, lastValue: value };
      this.labels.set(key, entry);
    } else if (entry.lastValue !== value) {
      entry.text.text = value;
      entry.lastValue = value;
      // A drone promoted to elite (its name arrives a snapshot after the
      // label was made) swaps to the elite style — only on a value change.
      entry.text.style = STYLES[style];
    }
    entry.text.x = x;
    entry.text.y = y;
  }

  destroy(): void {
    for (const entry of this.labels.values()) {
      entry.text.destroy({ texture: true, textureSource: true });
    }
    this.labels.clear();
    this.container.destroy({ children: true });
  }
}
