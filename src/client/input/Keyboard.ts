import { useUIStore } from '../state/store.js';

export interface InputState {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** True every read() call while space is held. */
  fireHeld: boolean;
  /** True while either Shift key is held. Multiplies thrust impulse server-side. */
  boost: boolean;
  /** True while S / Down arrow is held. Drifty-arcade reverse impulse. */
  reverse: boolean;
}

export class Keyboard {
  thrust = false;
  turnLeft = false;
  turnRight = false;
  boost = false;
  reverse = false;
  private spaceDown = false;
  /**
   * Plan: crispy-kazoo, Commit 4 — pause boundary.
   * When false, `read()` returns IDLE and keydown/keyup are masked.
   * DOM listeners stay attached so the user re-pressing a key after
   * re-enable starts fresh (the disabled-window keypresses are
   * silently swallowed). Toggled by App.tsx GameSurface's
   * useIsLoadingActive effect.
   */
  private enabled = true;

  /** Zero every held-key bool. Called on disable so the joiner can't
   *  "auto-thrust on curtain lift" if they were holding W when they
   *  died and held it through the respawn. */
  private clearHeldKeys(): void {
    this.thrust = false;
    this.turnLeft = false;
    this.turnRight = false;
    this.boost = false;
    this.reverse = false;
    this.spaceDown = false;
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) this.clearHeldKeys();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.thrust = true;
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.reverse = true;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.turnLeft = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.turnRight = true;
        break;
      case 'Space':
        this.spaceDown = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.boost = true;
        break;
      case 'Digit1':
      case 'Numpad1':
        useUIStore.getState().setActiveWeapon('hitscan');
        break;
      case 'Digit2':
      case 'Numpad2':
        useUIStore.getState().setActiveWeapon('laser');
        break;
      case 'KeyQ':
        useUIStore.getState().cycleWeapon();
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.thrust = false;
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.reverse = false;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.turnLeft = false;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.turnRight = false;
        break;
      case 'Space':
        this.spaceDown = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.boost = false;
        break;
    }
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  read(): InputState {
    if (!this.enabled) {
      return {
        thrust: false,
        turnLeft: false,
        turnRight: false,
        fireHeld: false,
        boost: false,
        reverse: false,
      };
    }
    return {
      thrust: this.thrust,
      turnLeft: this.turnLeft,
      turnRight: this.turnRight,
      fireHeld: this.spaceDown,
      boost: this.boost,
      reverse: this.reverse,
    };
  }
}
