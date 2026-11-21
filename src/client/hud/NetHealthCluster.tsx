/**
 * Net-health HUD cluster: small icon + number chips that appear only while the
 * connection is bad (high ping, snapshot stalls, own-ship corrections, drone
 * interpolation misses, disconnected / WebSocket fallback), so a player can
 * tell network trouble from a game bug.
 *
 * Reads the counters the game already keeps (no second stats pipeline):
 * `ColyseusClient.stats`, the swarm-interpolation / clock-anchor / render-due
 * snap counters (the same ones the phone-lane `perf_summary` logs) and the
 * DataChannel transport. Sampled on a 10 Hz wall-clock timer, never per frame;
 * re-renders at most every `NET_HEALTH_PUBLISH_MS`, and only when a shown value
 * changes. Logic and thresholds: `netHealth.ts`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import SignalCellularAltIcon from '@mui/icons-material/SignalCellularAlt';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import LanIcon from '@mui/icons-material/Lan';
import { useUIStore } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { snapshotTransportFellBack } from '../net/connection/roomConnection.js';
import { getSwarmGlideLimitCount, getSwarmOldEndClampCount } from '../net/swarmInterpolation.js';
import { getAnchorHardSnapCount } from '../net/clockAnchor.js';
import { getRenderDueSnapCount } from '../net/renderTickPhase.js';
import { HUD } from './tokens';
import {
  NET_HEALTH_PUBLISH_MS, NET_HEALTH_SAMPLE_MS, NetHealthMonitor, PING_WARN_MS, PING_BAD_MS,
  SNAPSHOT_STALL_MS, OWN_CORRECTIONS_PER_S, DRONE_MISSES_PER_DRONE_S,
  formatNetMs, netHealthDisplayKey, type NetHealthSample,
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
  out.timelineSnaps = getAnchorHardSnapCount() + getRenderDueSnapCount();
  out.ownCorrections = st.significantCorrectionCount;
  out.droneMisses = getSwarmGlideLimitCount() + getSwarmOldEndClampCount();
  out.droneCount = client.mirror.swarm?.size ?? 0;
}

const PING_TIP = `Ping: round-trip time to the server, 1 s average. Shows over ${PING_WARN_MS} ms, red over ${PING_BAD_MS} ms.`;
const STALL_TIP = `Snapshot stall: longest wait for a server update in the last second (shows over ${SNAPSHOT_STALL_MS} ms or on a timeline re-sync).`;
const CORR_TIP = `Corrections: times per second your ship was snapped to the server's position (shows over ${OWN_CORRECTIONS_PER_S}/s).`;
const DRONE_TIP = `Drone misses: frames per drone per second where drones froze waiting for data (shows over ${DRONE_MISSES_PER_DRONE_S}/s).`;
const DOWN_TIP = 'Disconnected from the server: reconnecting.';
const WS_TIP = 'WebRTC failed: game updates are on the slower WebSocket fallback.';

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
      timelineSnaps: 0, ownCorrections: 0, droneMisses: 0, droneCount: 0,
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
  if (v.ping.shown) tips.push(PING_TIP);
  if (v.stall.shown) tips.push(STALL_TIP);
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
        {v.ping.shown && (
          <Chip testId="net-ping" tip={PING_TIP} size={size} icon={<SignalCellularAltIcon sx={icon} />}
            color={v.ping.level === 'bad' ? HUD.color.hullCrit : HUD.color.hullWarn} text={`${Math.round(v.ping.ms)}`} />
        )}
        {v.stall.shown && (
          <Chip testId="net-stall" tip={STALL_TIP} color={HUD.color.hullWarn} size={size}
            icon={<HourglassBottomIcon sx={icon} />} text={formatNetMs(v.stall.ms)} />
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
