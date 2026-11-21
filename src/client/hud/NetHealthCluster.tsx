/**
 * Net-health HUD cluster: small icon + number chips that appear only while
 * something is wrong, each saying whose fault it is: the network (late or
 * gappy arrivals against the server's send stamp, high ping), the server
 * (it sent late, or time dilation), or this device (frames took too long to
 * draw). Own-ship corrections and drone misses show the consequences; the
 * link chip shows a disconnect or the WebSocket fallback.
 *
 * Reads the counters the game already keeps (no second stats pipeline):
 * `ColyseusClient.stats`, the per-arrival snapshot counters
 * (`snapshotArrivalStats.ts`, fed from the existing recv-telemetry hook), the
 * frame-hitch counters beside `RafStallDetector` (the phone-lane hitch bound),
 * the long-task feed (`healthStats.ts`), the store's `clockRate`, the swarm
 * interpolation miss counters and the DataChannel transport. Sampled on a
 * 10 Hz wall-clock timer, never per frame; re-renders at most every
 * `NET_HEALTH_PUBLISH_MS`, and only when a shown value changes. Logic and
 * thresholds: `netHealth.ts`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt';
import DnsIcon from '@mui/icons-material/Dns';
import SmartphoneIcon from '@mui/icons-material/Smartphone';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import LanIcon from '@mui/icons-material/Lan';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { snapshotTransportFellBack } from '../net/connection/roomConnection.js';
import { getSwarmGlideLimitCount, getSwarmOldEndClampCount } from '../net/swarmInterpolation.js';
import {
  ARRIVAL_LATE_BAD_MS, ARRIVAL_LATE_WARN_MS, NET_GAP_MS, NET_GAP_SEVERE_MS, SERVER_SEND_GAP_MS,
  getArrivalLateBadCount, getArrivalLateWarnCount, getNetGapCount, getNetGapSevereCount,
  getSnapshotArrivalCount, takeArrivalLatenessPeakMs, takeServerSendGapPeakMs,
} from '../net/snapshotArrivalStats.js';
import { FRAME_SEVERE_HITCH_MS, getFrameHitchCount, getFrameSevereHitchCount } from '../net/RafStallDetector.js';
import { LANE_HITCH_MS } from '../debug/perf/laneFrameSummary.js';
import { getLongtaskTotalCount } from '../debug/healthStats.js';
import { HUD } from './tokens';
import {
  NET_HEALTH_PUBLISH_MS, NET_HEALTH_SAMPLE_MS, NetHealthMonitor, NET_RTT_WARN_MS, NET_RTT_BAD_MS,
  NET_GAPS_WARN_PER_MIN, NET_GAPS_BAD_PER_MIN, SERVER_SEND_GAP_BAD_MS, SERVER_CLOCK_RATE_WARN,
  SERVER_CLOCK_RATE_BAD, DEVICE_STALLS_WARN_PER_S, DEVICE_STALLS_BAD_PER_S, OWN_CORRECTIONS_PER_S,
  DRONE_MISSES_PER_DRONE_S, netHealthDisplayKey, networkReadout, serverReadout,
  type NetHealthSample, type NetLevel,
} from './netHealth';

/** Fill `out` from the live counters. Allocates nothing. */
function readNetHealthSample(out: NetHealthSample): void {
  const ui = useUIStore.getState();
  const client = getGameClient();
  const inSector = ui.phase === 'game' && ui.transitState !== 'IN_TRANSIT' && ui.transitState !== 'SPOOLING';
  out.active = inSector && client !== null;
  if (!out.active || client === null) return;
  const st = client.stats;
  out.connected = ui.connectionStatus === 'connected';
  out.transportFellBack = snapshotTransportFellBack();
  out.rttMs = st.rttMs;
  out.lastSnapshotRecvAtMs = st.lastSnapshotRecvAtMs ?? -1;
  out.arrivals = getSnapshotArrivalCount();
  out.lateWarn = getArrivalLateWarnCount();
  out.lateBad = getArrivalLateBadCount();
  out.netGaps = getNetGapCount();
  out.netGapsSevere = getNetGapSevereCount();
  out.latenessPeakMs = takeArrivalLatenessPeakMs();
  out.serverSendGapPeakMs = takeServerSendGapPeakMs();
  out.serverClockRate = ui.clockRate;
  out.frameHitches = getFrameHitchCount();
  out.frameSevereHitches = getFrameSevereHitchCount();
  out.longtasks = getLongtaskTotalCount();
  out.ownCorrections = st.significantCorrectionCount;
  out.droneMisses = getSwarmGlideLimitCount() + getSwarmOldEndClampCount();
  out.droneCount = client.mirror.swarm?.size ?? 0;
}

const NET_TIP = `Network: updates the server sent on time arrived late or with gaps, or ping is high. `
  + `Amber past ping ${NET_RTT_WARN_MS} ms, lateness ${ARRIVAL_LATE_WARN_MS} ms (p95) or ${NET_GAPS_WARN_PER_MIN} gaps over ${NET_GAP_MS} ms a minute; `
  + `red past ping ${NET_RTT_BAD_MS} ms, lateness ${ARRIVAL_LATE_BAD_MS} ms, ${NET_GAPS_BAD_PER_MIN} gaps a minute or a gap over ${NET_GAP_SEVERE_MS / 1000} s.`;
const SERVER_TIP = `Server: the server itself sent updates late (gap over ${SERVER_SEND_GAP_MS} ms, red over ${SERVER_SEND_GAP_BAD_MS / 1000} s) `
  + `or is slowed down (time dilation under ${Math.round(SERVER_CLOCK_RATE_WARN * 100)}%, red under ${Math.round(SERVER_CLOCK_RATE_BAD * 100)}%).`;
const DEVICE_TIP = `This device: frames took too long to draw (over ${LANE_HITCH_MS} ms), whatever the network did. `
  + `Amber at ${DEVICE_STALLS_WARN_PER_S}/s, red at ${DEVICE_STALLS_BAD_PER_S}/s or one frame over ${FRAME_SEVERE_HITCH_MS} ms.`;
const CORR_TIP = `Corrections: times per second your ship was snapped to the server's position (shows over ${OWN_CORRECTIONS_PER_S}/s).`;
const DRONE_TIP = `Drone misses: frames per drone per second where drones froze waiting for data (shows over ${DRONE_MISSES_PER_DRONE_S}/s).`;
const DOWN_TIP = 'Disconnected from the server: reconnecting.';
const WS_TIP = 'WebRTC failed: game updates are on the slower WebSocket fallback.';

const levelColor = (level: NetLevel): string => (level === 'bad' ? HUD.color.hullCrit : HUD.color.hullWarn);

interface ChipProps { testId: string; tip: string; color: string; size: number; icon: ReactNode; text?: string }

function Chip({ testId, tip, color, size, icon, text }: ChipProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      title={tip}
      aria-label={tip}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color }}
    >
      {icon}
      {text !== undefined && <span style={{ fontFamily: HUD.font.num, fontSize: size }}>{text}</span>}
    </span>
  );
}

export function NetHealthCluster({ size = 9 }: { size?: number }): JSX.Element | null {
  const monitorRef = useRef<NetHealthMonitor | null>(null);
  if (monitorRef.current === null) monitorRef.current = new NetHealthMonitor();
  const [, setRev] = useState(0);
  const [tipOpen, setTipOpen] = useState(false);

  useEffect(() => {
    const monitor = monitorRef.current;
    if (monitor === null) return;
    const sample: NetHealthSample = {
      active: false, connected: true, transportFellBack: false, rttMs: 0, lastSnapshotRecvAtMs: -1,
      arrivals: 0, lateWarn: 0, lateBad: 0, netGaps: 0, netGapsSevere: 0, latenessPeakMs: 0,
      serverSendGapPeakMs: 0, serverClockRate: 1, frameHitches: 0, frameSevereHitches: 0, longtasks: 0,
      ownCorrections: 0, droneMisses: 0, droneCount: 0,
    };
    let lastKey = '';
    let lastPublishMs = 0;
    const tick = (): void => {
      // Real time: network health is measured in wall time
      const now = performance.now();
      readNetHealthSample(sample);
      monitor.sample(sample, now);
      if (now - lastPublishMs < NET_HEALTH_PUBLISH_MS) return;
      const key = netHealthDisplayKey(monitor.view);
      if (key === lastKey) return;
      lastKey = key;
      lastPublishMs = now;
      setRev((r) => r + 1);
    };
    // Real time: a wall-clock sampling cadence, independent of game speed
    const h = window.setInterval(tick, NET_HEALTH_SAMPLE_MS);
    return () => window.clearInterval(h);
  }, []);

  const v = monitorRef.current.view;
  if (!monitorRef.current.anyShown) return null;
  const icon = { fontSize: size + 3 } as const;
  const tips: string[] = [];
  if (v.link.shown) tips.push(v.link.state === 'down' ? DOWN_TIP : WS_TIP);
  if (v.network.shown) tips.push(NET_TIP);
  if (v.server.shown) tips.push(SERVER_TIP);
  if (v.device.shown) tips.push(DEVICE_TIP);
  if (v.corrections.shown) tips.push(CORR_TIP);
  if (v.drones.shown) tips.push(DRONE_TIP);

  return (
    <div
      data-testid="hud-net-health"
      data-hud-exclusion=""
      onPointerDown={(e) => { e.stopPropagation(); setTipOpen((o) => !o); }}
      style={{
        pointerEvents: 'auto', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
        padding: '3px 6px', borderRadius: 6, background: HUD.color.panel, border: `1px solid ${HUD.color.panelEdge}`,
        lineHeight: 1.2, maxWidth: 220,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {v.link.shown && (v.link.state === 'down'
          ? <Chip testId="net-link-down" tip={DOWN_TIP} color={HUD.color.hullCrit} size={size} icon={<CloudOffIcon sx={icon} />} />
          : <Chip testId="net-link-ws" tip={WS_TIP} color={HUD.color.hullWarn} size={size} icon={<LanIcon sx={icon} />} text="WS" />)}
        {v.network.shown && (
          <Chip testId="net-network" tip={NET_TIP} color={levelColor(v.network.level)} size={size}
            icon={<SignalCellularAltIcon sx={icon} />} text={networkReadout(v.network)} />
        )}
        {v.server.shown && (
          <Chip testId="net-server" tip={SERVER_TIP} color={levelColor(v.server.level)} size={size}
            icon={<DnsIcon sx={icon} />} text={serverReadout(v.server)} />
        )}
        {v.device.shown && (
          <Chip testId="net-device" tip={DEVICE_TIP} color={levelColor(v.device.level)} size={size}
            icon={<SmartphoneIcon sx={icon} />} text={`${Math.round(v.device.stallsPerS)}/s`} />
        )}
        {v.corrections.shown && (
          <Chip testId="net-corrections" tip={CORR_TIP} color={HUD.color.hullWarn} size={size}
            icon={<MyLocationIcon sx={icon} />} text={`${Math.round(v.corrections.perS)}/s`} />
        )}
        {v.drones.shown && (
          <Chip testId="net-drones" tip={DRONE_TIP} color={HUD.color.hullWarn} size={size}
            icon={<ScatterPlotIcon sx={icon} />} text={`${Math.round(v.drones.perDroneS)}/s`} />
        )}
      </div>
      {tipOpen && tips.map((t) => (
        <div key={t} style={{ fontFamily: HUD.font.label, fontSize: size - 1, color: HUD.color.inkDim, whiteSpace: 'normal' }}>{t}</div>
      ))}
    </div>
  );
}
