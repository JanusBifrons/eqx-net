/**
 * Net-health HUD items (pure): what each visible indicator shows in the
 * cluster (its short readout and the fixed width reserved for it) and in the
 * tap-to-open details (a short plain-English paragraph with the averaged
 * number). One list drives both, so the chips and the details always match.
 * Called on render only (at most every `NET_HEALTH_PUBLISH_MS`), never per
 * sample.
 */
import { LANE_HITCH_MS } from '../debug/perf/laneFrameSummary.js';
import { NET_GAP_MS } from '../net/snapshotArrivalStats.js';
import {
  SERVER_CLOCK_RATE_WARN, networkReadout, serverReadout, type NetHealthView, type NetLevel,
} from './netHealth';

export type NetItemKind = 'linkDown' | 'linkWs' | 'network' | 'server' | 'device' | 'corrections' | 'drones';

/**
 * Width reserved for each readout, in `ch` of the HUD's monospace number font,
 * sized for the longest readout the item can show so the cluster never shifts
 * when a value gains a digit:
 *   network "9999" ping, "+999ms" / "+99.9s" lateness, "999/min" gaps, "99.9s" wait;
 *   server "100%" dilation, "999ms" / "99.9s" send gap; rates "999/s".
 */
export const NET_SLOT_CH: Readonly<Record<NetItemKind, number>> = {
  linkDown: 0,
  linkWs: 2,
  network: 7,
  server: 5,
  device: 5,
  corrections: 5,
  drones: 5,
};

export interface NetHealthItem {
  kind: NetItemKind;
  level: NetLevel;
  /** Short number shown beside the icon in the cluster ('' = icon only). */
  readout: string;
  /** The details paragraph: who is at fault, the averaged number, 1–2 sentences. */
  text: string;
}

const MS_PER_S = 1000;
const PERCENT = 100;

/** A duration for prose: "450 ms" under a second, "1.3 s" above. */
export function proseMs(ms: number): string {
  return ms < MS_PER_S ? `${Math.round(ms)} ms` : `${(ms / MS_PER_S).toFixed(1)} s`;
}

/** "1 time" / "3 times"-style count with its noun. */
function count(n: number, one: string, many: string): string {
  const r = Math.round(n);
  return `${r} ${r === 1 ? one : many}`;
}

const NOT_SERVER = 'This is your connection, not the game server.';

function networkText(n: NetHealthView['network']): string {
  switch (n.cause) {
    case 'ping':
      return `Network — your ping peaked at ${proseMs(n.rttMs)} over the last second. ${NOT_SERVER}`;
    case 'late':
      return `Network — updates the server sent on time reached you up to ${proseMs(n.latenessMs)} late over the last second. ${NOT_SERVER}`;
    case 'gaps':
      return `Network — updates stopped for over ${proseMs(NET_GAP_MS)} ${count(n.gapsPerMin, 'time', 'times')} in the last minute. ${NOT_SERVER}`;
    case 'wait':
      return `Network — no update has reached you for ${proseMs(n.waitMs)}; the next one will show whether your connection or the server is to blame.`;
  }
}

function serverText(v: NetHealthView['server']): string {
  if (v.clockRate < SERVER_CLOCK_RATE_WARN) {
    return `Server — the game server is overloaded and running at ${Math.round(v.clockRate * PERCENT)}% speed; this is not your connection.`;
  }
  return `Server — the game server paused for up to ${proseMs(v.sendGapMs)} in the last second; this is not your connection.`;
}

/** The visible items, in cluster order (link, network, server, device, corrections, drones). */
export function netHealthItems(v: NetHealthView): NetHealthItem[] {
  const items: NetHealthItem[] = [];
  if (v.link.shown) {
    items.push(v.link.state === 'down'
      ? { kind: 'linkDown', level: 'bad', readout: '',
        text: 'Connection — you are disconnected from the game server and the game is reconnecting.' }
      : { kind: 'linkWs', level: 'warn', readout: 'WS',
        text: 'Connection — the fast WebRTC link failed, so game updates come over the slower WebSocket fallback.' });
  }
  if (v.network.shown) {
    items.push({ kind: 'network', level: v.network.level, readout: networkReadout(v.network), text: networkText(v.network) });
  }
  if (v.server.shown) {
    items.push({ kind: 'server', level: v.server.level, readout: serverReadout(v.server), text: serverText(v.server) });
  }
  if (v.device.shown) {
    const perS = Math.round(v.device.stallsPerS);
    items.push({ kind: 'device', level: v.device.level, readout: `${perS}/s`,
      text: `Device — ${count(perS, 'frame', 'frames')} a second took over ${LANE_HITCH_MS} ms to draw over the last second; this is your device, not the network.` });
  }
  if (v.corrections.shown) {
    const perS = Math.round(v.corrections.perS);
    items.push({ kind: 'corrections', level: 'warn', readout: `${perS}/s`,
      text: `Corrections — your ship was snapped back to the server's position ${count(perS, 'time', 'times')} a second over the last second.` });
  }
  if (v.drones.shown) {
    const perS = Math.round(v.drones.perDroneS);
    items.push({ kind: 'drones', level: 'warn', readout: `${perS}/s`,
      text: `Drones — each drone froze waiting for data on ${count(perS, 'frame', 'frames')} a second, averaged over the last second.` });
  }
  return items;
}
