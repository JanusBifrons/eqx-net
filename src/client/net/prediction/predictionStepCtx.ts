import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { PhysicsWorld } from '@core/physics/World';
import type { InputRecord, Reconciler } from '@core/prediction/Reconciler';
import type { ControlBits } from '@core/combat/disable';
import type { HelmOrder, HelmOutput } from '@core/helm/helm';
import type { TouchInput } from '../../input/TouchInput';
import type { JoystickInputState } from '../../input/joystickToInput';

/** One `keyboard.read()` (stateless, hoisted out of the input loop). */
export interface KeyboardBits {
  thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean; reverse: boolean;
}

/** The control state last sent to the server (idle-suppression + heartbeat). */
export interface SentInputState {
  thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number;
}

/** The pooled `predWorld.applyInput` argument. */
export interface ApplyInputScratch {
  thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number;
}

/** The pooled ordinary `input` send payload. */
export interface SendInputScratch {
  type: 'input'; tick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean;
}

/** The pooled `input` send payload while a warp is requested. */
export interface SendWarpInputScratch extends SendInputScratch { warpX: number; warpY: number }

/**
 * What the prediction step passes (`inputStep.ts`) read and write on
 * `ColyseusClient`. Built ONCE (#14): fields the client reassigns are getters
 * (and setters where a pass writes them), so a pass never holds a stale value
 * and no call allocates.
 */
export interface PredictionStepCtx {
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly predWorld: PhysicsWorld | null;
  readonly reconciler: Reconciler | null;
  readonly touchInput: TouchInput | null;
  readonly localDead: boolean;
  inputTick: number;
  predEnergy: number;
  energySeeded: boolean;
  joystickInputState: JoystickInputState;
  warpRequest: { x: number; y: number } | null;
  lastSentInputState: SentInputState | null;
  lastSentInputAtMs: number;
  /** Wall ms the latest predicted tick stands for (render dead-reckon anchor). */
  lastLocalTickAtMs: number;
  readonly clockAnchorPerfNow: number;
  readonly clockAnchorServerTick: number;
  readonly helmOrder: HelmOrder;
  readonly helmOut: HelmOutput;
  readonly disableBits: ControlBits;
  readonly inputRecScratch: InputRecord;
  readonly applyInputScratch: ApplyInputScratch;
  readonly sendInputScratch: SendInputScratch;
  readonly sendWarpInputScratch: SendWarpInputScratch;
  clearHelm(): void;
  stepHelm(): void;
  isLocallyDisabled(): boolean;
  gameLeadTicks(): number;
  applyRemoteInputs(): void;
  tickLocalMountAim(dt: number): void;
}
