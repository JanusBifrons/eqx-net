/**
 * Phase 5 — WASD / arrow-key free-pan for SPECTATOR mode (desktop).
 *
 * The gameplay `Keyboard` is DISABLED in spectator (so W/Space produce no
 * thrust/fire — the "W must NOT thrust the ship" lock). This is a SEPARATE,
 * dedicated reader that tracks the WASD/arrow keys only while ENABLED (the App
 * enables it exactly when spectating + desktop) and emits a camera-pan VELOCITY
 * on each held-key change — never per frame. The renderer integrates the
 * velocity in `Camera.tick` (eased in on press, gliding to a stop on release —
 * `PAN_EASE_MS`), so a held key produces continuous panning with a
 * handful of messages, not one per frame (no worker-IPC churn).
 *
 * Velocity is SCREEN px/sec, matching the drag-pan's `target += delta` sign
 * convention so WASD and drag agree: A pans the view left, D right, W up, S down
 * (RTS feel — the camera moves in the key's direction).
 */

/** Screen px/sec at full single-axis deflection. */
export const SPECTATOR_PAN_SPEED = 800;

function isTextEntryTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export class SpectatorPanInput {
  private up = false;
  private down = false;
  private left = false;
  private right = false;
  private enabled = false;
  private lastVx = 0;
  private lastVy = 0;
  private readonly onChange: (vx: number, vy: number) => void;
  private readonly onHold: (() => void) | undefined;

  /** `onHold` fires on an `H` press (RTS "hold / stop" for the current fleet
   *  selection) while enabled and focus is not in a text field. */
  constructor(onChange: (vx: number, vy: number) => void, onHold?: () => void) {
    this.onChange = onChange;
    this.onHold = onHold;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  /** Enable only while spectating + desktop. Disabling resets every held key and
   *  emits a (0,0) stop so a lingering velocity can't keep the camera drifting. */
  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) {
      this.up = this.down = this.left = this.right = false;
    }
    this.emit();
  }

  private set(code: string, down: boolean): boolean {
    switch (code) {
      case 'KeyW': case 'ArrowUp': this.up = down; return true;
      case 'KeyS': case 'ArrowDown': this.down = down; return true;
      case 'KeyA': case 'ArrowLeft': this.left = down; return true;
      case 'KeyD': case 'ArrowRight': this.right = down; return true;
      default: return false;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || e.repeat) return;
    if (e.code === 'KeyH') {
      if (this.onHold && !isTextEntryTarget(e.target)) this.onHold();
      return;
    }
    if (this.set(e.code, true)) this.emit();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (this.set(e.code, false)) this.emit();
  };

  /** Recompute the velocity and notify ONLY when it changed. */
  private emit(): void {
    // A pans the view LEFT (target.x +), D right (−); W up (target.y +), S down.
    let dx = (this.left ? 1 : 0) - (this.right ? 1 : 0);
    let dy = (this.up ? 1 : 0) - (this.down ? 1 : 0);
    // Normalise a diagonal so it isn't √2 faster than a single axis.
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }
    const vx = dx * SPECTATOR_PAN_SPEED;
    const vy = dy * SPECTATOR_PAN_SPEED;
    if (vx !== this.lastVx || vy !== this.lastVy) {
      this.lastVx = vx;
      this.lastVy = vy;
      this.onChange(vx, vy);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
