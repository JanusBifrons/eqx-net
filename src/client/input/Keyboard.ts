export interface InputState {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** True every read() call while space is held. */
  fireHeld: boolean;
}

export class Keyboard {
  thrust = false;
  turnLeft = false;
  turnRight = false;
  private spaceDown = false;

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.thrust = true;
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
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.thrust = false;
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
    return {
      thrust: this.thrust,
      turnLeft: this.turnLeft,
      turnRight: this.turnRight,
      fireHeld: this.spaceDown,
    };
  }
}
