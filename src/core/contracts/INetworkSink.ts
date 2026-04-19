export interface INetworkSink {
  sendInput(thrust: boolean, turnLeft: boolean, turnRight: boolean, tick: number): void;
  dispose(): void;
}
