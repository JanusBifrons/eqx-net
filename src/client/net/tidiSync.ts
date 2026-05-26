/**
 * Per-snapshot TiDi (Time Dilation) sync — surfaces the server's
 * `state.clockRate` to the HUD (Zustand) + the audio system, and
 * drives the diegetic "Temporal Anomaly" sector-alert banner.
 *
 * The Colyseus schema diff already updates `room.state.clockRate`
 * (Phase 6 sync stays free); reading it on every snapshot is a cheap
 * polling heartbeat that avoids a separate listener on a single
 * scalar.
 *
 * Hysteresis on the *rate* edges (0.99 set / 1.00 clear) avoids
 * flicker as the EWMA boundary is crossed during recovery. The alert
 * slot is shared with combat ('SHIP DESTROYED', 'shot_rejected') —
 * read the live value so we never stomp those, and only clear our
 * own banner string.
 */

import type { Room } from 'colyseus.js';
import type { IAudio } from '@core/contracts/IAudio';
import { useUIStore } from '../state/store';

export function syncTidiFromRoom(room: Room | null, audio: IAudio | null): void {
  if (!room) return;
  const stateAny = room.state as unknown as { clockRate?: number };
  const rate = typeof stateAny.clockRate === 'number' ? stateAny.clockRate : 1.0;
  const ui = useUIStore.getState();
  ui.setClockRate(rate);
  audio?.setClockRate(rate);
  const current = ui.sectorAlert;
  if (rate < 0.99 && (current === null || current === 'Temporal Anomaly')) {
    if (current !== 'Temporal Anomaly') ui.setSectorAlert('Temporal Anomaly');
  } else if (rate >= 1.0 && current === 'Temporal Anomaly') {
    ui.setSectorAlert(null);
  }
}
