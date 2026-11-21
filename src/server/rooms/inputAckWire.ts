/**
 * The per-recipient input acknowledgement on a snapshot: `ackedTick` (the
 * worker's ack) and `inputMargin`, the margin of this pilot's latest input
 * since its last snapshot (`inputLeadMargin`, recorded by the input handler).
 * The client sizes its input lead from the margin (`rttLookaheadUpdater`);
 * it is sent once, then forgotten, so a pilot who sends nothing gets none.
 * Extension point of `SnapshotBroadcaster`; no allocation (#14).
 */

export interface InputAckFields {
  ackedTick: number;
  inputMargin?: number;
}

export function writeInputAck(
  snap: InputAckFields,
  ackedTick: number,
  margins: Map<string, number>,
  playerId: string,
): void {
  snap.ackedTick = ackedTick;
  const margin = margins.get(playerId);
  if (margin !== undefined) {
    snap.inputMargin = margin;
    margins.delete(playerId);
  } else if ('inputMargin' in snap) {
    delete snap.inputMargin;
  }
}
