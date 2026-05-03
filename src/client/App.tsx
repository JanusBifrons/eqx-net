import { useState, useEffect, useRef, useCallback } from 'react';
import { installWindowLogger } from './debug/ClientLogger';
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Chip,
  Alert,
} from '@mui/material';
import { ColyseusGameClient } from './net/ColyseusClient';
import { PixiRenderer } from './render/PixiRenderer';
import { Keyboard } from './input/Keyboard';
import { TouchInput, isTouchDevice } from './input/TouchInput';
import { LocalGameClient } from './local/LocalGameClient';
import { loadStoredPlayerId, persistPlayerId } from './identity/token';
import { useUIStore } from './state/store';
import { useAuthStore } from './auth/authStore';
import { AppHeader } from './components/AppHeader';
import { LoginPage } from './components/LoginPage';
import { ProfileModal } from './components/ProfileModal';
import { SettingsModal } from './components/SettingsModal';
import { MobileControls } from './components/MobileControls';

// Default to the page's own origin so the same dev server is reachable from
// phones on the LAN (e.g. http://192.168.1.5:5173 → ws://192.168.1.5:5173).
// Override with VITE_WS_URL in .env for cross-origin setups.
const SERVER_URL =
  import.meta.env['VITE_WS_URL'] ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');

// Install window.__eqxLogs and window.__eqxClearLogs at module load time.
installWindowLogger();

interface EqxLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    __eqxLogs?: EqxLogEntry[];
    __eqxEpoch?: number;
  }
}

/** Live scrolling log of the last N correction events, updating every 300 ms. */
function LogPanel(): JSX.Element {
  const [entries, setEntries] = useState<EqxLogEntry[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      const all: EqxLogEntry[] = window.__eqxLogs ?? [];
      // Show last 20 correction or snapshot entries.
      const relevant = all.filter((e) => e.tag === 'correction' || e.tag === 'snapshot').slice(-20);
      setEntries([...relevant]);
    }, 300);
    return () => clearInterval(id);
  }, []);

  const epoch = typeof window.__eqxEpoch === 'number' ? window.__eqxEpoch : 0;
  const t0 = entries[0]?.ts ?? 0;

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        right: 16,
        zIndex: 10,
        bgcolor: 'rgba(0,0,0,0.82)',
        color: '#ccc',
        fontFamily: 'monospace',
        fontSize: 10,
        p: 1,
        borderRadius: 1,
        pointerEvents: 'none',
        maxHeight: 180,
        overflow: 'hidden',
      }}
    >
      <div style={{ color: '#888', marginBottom: 2 }}>
        Log (epoch+{epoch ? ((Date.now() - epoch) / 1000).toFixed(1) : '?'}s) — corrections=orange, snapshots=grey
      </div>
      {entries.map((e, i) => {
        const isCorr = e.tag === 'correction';
        const rel = (e.ts - t0).toFixed(0).padStart(5);
        const color = isCorr ? '#ff6622' : '#667';
        const d = (k: string): string => String(e.data[k] ?? '?');
        if (isCorr) {
          return (
            <div key={i} style={{ color }}>
              t+{rel}ms CORR  drift={d('driftUnits').slice(0, 8)}  ahead={d('ticksAhead')}  acked={d('ackedTick')}  tick={d('serverTick')}
            </div>
          );
        }
        return (
          <div key={i} style={{ color }}>
            t+{rel}ms snap  drift={d('driftUnits').slice(0, 8)}  ahead={d('ticksAhead')}  acked={d('ackedTick')}  tick={d('serverTick')}
          </div>
        );
      })}
    </Box>
  );
}

function DevOverlay(): JSX.Element {
  const { devData } = useUIStore();
  const corrRate = devData.snapshotCount > 0
    ? ((devData.significantCorrectionCount / devData.snapshotCount) * 100).toFixed(0)
    : '0';
  const f = (n: number): string => n.toFixed(2);
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 10,
        bgcolor: 'rgba(0,0,0,0.82)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 11,
        p: 1,
        borderRadius: 1,
        pointerEvents: 'none',
        lineHeight: 1.6,
        minWidth: 260,
      }}
    >
      <div style={{ color: '#0f8', fontWeight: 'bold' }}>── Sync ──</div>
      <div>RTT: {devData.rtt} ms</div>
      <div>Drift: {devData.drift.toFixed(4)} u  Max: {devData.maxDriftUnits.toFixed(4)} u</div>
      <div style={{ color: devData.significantCorrectionCount / Math.max(1, devData.snapshotCount) > 0.05 ? '#f44' : '#0f0' }}>
        Corrections: {devData.significantCorrectionCount}/{devData.snapshotCount} ({corrRate}%)
      </div>
      <div>Lerping: {devData.lerping ? 'yes' : 'no'}</div>
      <div style={{ borderTop: '1px solid #0f04', marginTop: 4, paddingTop: 4, color: '#0f8', fontWeight: 'bold' }}>── Ticks ──</div>
      <div>ackedTick: {devData.ackedTick}  inputTick: {devData.inputTick}</div>
      <div style={{ color: devData.ticksAhead > 10 ? '#ff0' : '#0f0' }}>
        ticksAhead: {devData.ticksAhead}  serverTick: {devData.serverTick}
      </div>
      <div>Snap interval: {devData.snapshotIntervalMs.toFixed(0)} ms</div>
      <div style={{ borderTop: '1px solid #0f04', marginTop: 4, paddingTop: 4, color: '#0f8', fontWeight: 'bold' }}>── Positions ──</div>
      <div style={{ color: '#ff6622' }}>Server(ghost): ({f(devData.serverX)}, {f(devData.serverY)})</div>
      <div>Before: ({f(devData.beforeX)}, {f(devData.beforeY)})</div>
      <div>After:  ({f(devData.afterX)}, {f(devData.afterY)})</div>
    </Box>
  );
}

function DevOverlayGate(): JSX.Element {
  const show = useUIStore((s) => s.showDevOverlay);
  return show ? <DevOverlay /> : <></>;
}

function LogPanelGate(): JSX.Element {
  const show = useUIStore((s) => s.showLogPanel);
  return show ? <LogPanel /> : <></>;
}

function HUD(): JSX.Element {
  const { connectionStatus, sectorName, hullPct, ammo, sectorAlert, playerId, shipCount, correctionRate, devData } =
    useUIStore();

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        pointerEvents: 'none',
      }}
    >
      {sectorName && (
        <Typography variant="overline" sx={{ color: '#fff', opacity: 0.7 }}>
          {sectorName}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Chip
          label={`Hull ${hullPct}%`}
          size="small"
          sx={{ bgcolor: hullPct > 50 ? '#1a7a3f' : '#7a1a1a', color: '#fff' }}
        />
        <Chip
          label={`Ammo ${ammo}`}
          size="small"
          sx={{ bgcolor: '#1a3a7a', color: '#fff' }}
        />
        <Chip
          label={connectionStatus}
          size="small"
          sx={{
            bgcolor: connectionStatus === 'connected' ? '#1a4a1a' : '#4a1a1a',
            color: '#fff',
          }}
        />
      </Box>
      {sectorAlert && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {sectorAlert}
        </Alert>
      )}
      {playerId && (
        <Typography variant="caption" sx={{ color: '#888', fontSize: 10 }}>
          ID: {playerId.slice(0, 8)}
        </Typography>
      )}
      <Typography
        variant="caption"
        data-testid="ship-count"
        sx={{ color: '#888', fontSize: 10 }}
      >
        Ships: {shipCount}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          fontSize: 10,
          color: correctionRate === 0 ? '#0f0' : correctionRate < 0.2 ? '#ff0' : '#f44',
          fontFamily: 'monospace',
        }}
      >
        Corr: {devData.significantCorrectionCount}/{devData.snapshotCount} ({(correctionRate * 100).toFixed(0)}%)
      </Typography>
    </Box>
  );
}

function DeathOverlay({ onRespawn }: { onRespawn: () => void }): JSX.Element {
  const isDead = useUIStore((s) => s.isDead);
  if (!isDead) return <></>;
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.65)',
        gap: 3,
        pointerEvents: 'all',
      }}
    >
      <Typography
        variant="h2"
        sx={{ color: '#ff3333', fontWeight: 700, letterSpacing: 6, textTransform: 'uppercase', textShadow: '0 0 30px #ff0000' }}
      >
        You Died
      </Typography>
      <Button
        variant="contained"
        size="large"
        onClick={onRespawn}
        sx={{
          bgcolor: '#00ff88',
          color: '#000',
          fontWeight: 700,
          px: 6,
          fontSize: '1.1rem',
          '&:hover': { bgcolor: '#00cc6a' },
        }}
      >
        Respawn
      </Button>
    </Box>
  );
}

function GameSurface(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ColyseusGameClient | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const animFrameRef = useRef<number>(0);
  const isTouchRef = useRef<boolean>(isTouchDevice());
  const touchInputRef = useRef<TouchInput | null>(
    isTouchRef.current ? new TouchInput() : null,
  );
  const { setConnectionStatus, setPlayerId, setSectorName, toggleDevOverlay } =
    useUIStore();

  const handleRespawn = useCallback(() => {
    clientRef.current?.respawnShip();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let disposed = false;

    const keyboard = new Keyboard();
    keyboardRef.current = keyboard;

    const renderer = new PixiRenderer();
    rendererRef.current = renderer;

    const gameClient = new ColyseusGameClient();
    clientRef.current = gameClient;
    // Expose for the dev-only diagnostic capture (SettingsModal "Capture" button
    // reads `__eqxClient.stats`). DEV-only assignment guarded by Vite's tree-shaking.
    if (import.meta.env.DEV) {
      (window as unknown as { __eqxClient?: ColyseusGameClient }).__eqxClient = gameClient;
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.shiftKey && e.key === 'D') toggleDevOverlay();
    };
    window.addEventListener('keydown', onKey);

    (async () => {
      await renderer.init(el);

      // StrictMode fires cleanup before the async init resolves. If disposal
      // happened while we were awaiting, tear down the just-initialised renderer
      // (which appended a canvas) and exit — the second mount will take over.
      if (disposed) {
        renderer.dispose();
        return;
      }

      let lastFrameTime = 0;
      const loop = (now: number): void => {
        if (!disposed) {
          const deltaMs = lastFrameTime > 0 ? now - lastFrameTime : 1000 / 60;
          lastFrameTime = now;
          gameClient.tickPhysics(deltaMs);
          gameClient.updateMirror();
          renderer.update(gameClient.mirror);
          // Clear one-frame triggers after the renderer has consumed them.
          gameClient.mirror.explodingShips?.clear();
          const localId = gameClient.mirror.localPlayerId;
          const localShip = localId ? gameClient.mirror.ships.get(localId) : null;
          if (localShip) {
            el.dataset['shipX'] = localShip.x.toFixed(3);
            el.dataset['shipY'] = localShip.y.toFixed(3);
            el.dataset['shipAngle'] = localShip.angle.toFixed(4);
          }
          // Expose all ship positions for E2E cross-client position assertions.
          const posMap: Record<string, { x: number; y: number }> = {};
          for (const [id, s] of gameClient.mirror.ships) {
            posMap[id] = { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)) };
          }
          el.dataset['shipPositions'] = JSON.stringify(posMap);
          el.dataset['localPlayerId'] = localId ?? '';
          el.dataset['predStats'] = JSON.stringify(gameClient.stats);
          // Expose combat state for E2E assertions.
          const uiState = useUIStore.getState();
          el.dataset['hullPct'] = String(uiState.hullPct);
          el.dataset['sectorAlert'] = uiState.sectorAlert ?? '';
          el.dataset['projectileCount'] = String(gameClient.mirror.projectiles?.size ?? 0);
          el.dataset['beamActive'] = gameClient.mirror.liveBeam ? '1' : '0';
          // Expose the beam's derived start-point so E2E tests can prove the
          // local laser is glued to the ship's lerped pose (no desync during
          // server-correction lerps). Computed identically to PixiRenderer's
          // own derivation: from = ship + 20*forward(ship.angle).
          if (gameClient.mirror.liveBeam && localShip) {
            const fwdX = -Math.sin(localShip.angle);
            const fwdY =  Math.cos(localShip.angle);
            el.dataset['beamFromX'] = (localShip.x + fwdX * 20).toFixed(3);
            el.dataset['beamFromY'] = (localShip.y + fwdY * 20).toFixed(3);
            el.dataset['beamDist']  = gameClient.mirror.liveBeam.dist.toFixed(3);
          } else {
            delete el.dataset['beamFromX'];
            delete el.dataset['beamFromY'];
            delete el.dataset['beamDist'];
          }
          el.dataset['remoteLaserCount'] = String(gameClient.mirror.remoteLasers?.size ?? 0);
          const remoteHitTargetIds: string[] = [];
          // Wire-side beam ranges per shooter — exposed so E2E can assert
          // that a hit beam was truncated server-side (range < HITSCAN_RANGE).
          const remoteLaserRanges: Record<string, number> = {};
          if (gameClient.mirror.remoteLasers) {
            for (const [shooterId, l] of gameClient.mirror.remoteLasers) {
              if (l.targetId) remoteHitTargetIds.push(l.targetId);
              remoteLaserRanges[shooterId] = parseFloat(l.range.toFixed(2));
            }
          }
          el.dataset['remoteHitTargets'] = JSON.stringify(remoteHitTargetIds);
          el.dataset['remoteLaserRanges'] = JSON.stringify(remoteLaserRanges);
          // Expose swarm positions (asteroids/drones) for E2E collision stability
          // assertions. The string-keyed `data-obstacle-positions` attribute is
          // preserved so existing E2E tests keep working: each swarm entityId is
          // serialised as `swarm-${entityId}` to differentiate from the old
          // hand-rolled `asteroid-N` ids the legacy MapSchema used.
          if (gameClient.mirror.swarm) {
            const swarmMap: Record<string, { x: number; y: number }> = {};
            const swarmDetail: Record<string, { x: number; y: number; angle: number; kind: number; sleeping: boolean; lastUpdateTick: number }> = {};
            for (const [entityId, entry] of gameClient.mirror.swarm.entries()) {
              const key = `swarm-${entityId}`;
              swarmMap[key] = { x: parseFloat(entry.x.toFixed(3)), y: parseFloat(entry.y.toFixed(3)) };
              swarmDetail[key] = {
                x: parseFloat(entry.x.toFixed(3)),
                y: parseFloat(entry.y.toFixed(3)),
                angle: parseFloat(entry.angle.toFixed(4)),
                kind: entry.kind,
                sleeping: entry.sleeping,
                lastUpdateTick: entry.lastUpdateTick,
              };
            }
            el.dataset['obstaclePositions'] = JSON.stringify(swarmMap);
            el.dataset['swarmDetail'] = JSON.stringify(swarmDetail);
          }
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };
      animFrameRef.current = requestAnimationFrame(loop);

      const storedId = loadStoredPlayerId();
      const urlParams = new URLSearchParams(window.location.search);
      const roomName = urlParams.get('room') ?? 'sector';
      const extraJoinOptions: Record<string, unknown> = {};
      if (urlParams.has('spawnX')) extraJoinOptions['spawnX'] = parseFloat(urlParams.get('spawnX')!);
      if (urlParams.has('spawnY')) extraJoinOptions['spawnY'] = parseFloat(urlParams.get('spawnY')!);

      await gameClient.connect(SERVER_URL, storedId, keyboard, {
        onConnectionStatus: setConnectionStatus,
        onPlayerId: (id) => {
          persistPlayerId(id);
          setPlayerId(id);
        },
      }, roomName, extraJoinOptions, touchInputRef.current ?? undefined);

      setSectorName(roomName === 'test-sector' ? 'Test Sector' : 'Sector Alpha');
    })().catch((err: unknown) => {
      console.error('[GameSurface] connection failed', err);
      setConnectionStatus('error');
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('keydown', onKey);
      keyboard.dispose();
      gameClient.dispose();
      renderer.dispose();
    };
  }, [setConnectionStatus, setPlayerId, setSectorName, toggleDevOverlay]);

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        // dvh: dynamic viewport height — accounts for mobile URL bar show/hide.
        // Falls back to 100vh on older browsers (iOS < 15.4).
        '@supports (height: 100dvh)': { height: '100dvh' },
        overflow: 'hidden',
        bgcolor: '#05070f',
        touchAction: 'none',
      }}
    >
      <div
        ref={containerRef}
        data-testid="game-surface"
        style={{ width: '100%', height: '100%', touchAction: 'none' }}
      />
      <HUD />
      <DevOverlayGate />
      <LogPanelGate />
      <DeathOverlay onRespawn={handleRespawn} />
      {isTouchRef.current && touchInputRef.current && (
        <MobileControls touchInput={touchInputRef.current} />
      )}
    </Box>
  );
}

function LocalSurface(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<LocalGameClient | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let disposed = false;

    const keyboard = new Keyboard();
    keyboardRef.current = keyboard;

    const renderer = new PixiRenderer();
    rendererRef.current = renderer;

    const gameClient = new LocalGameClient();
    clientRef.current = gameClient;

    (async () => {
      await renderer.init(el);
      if (disposed) {
        renderer.dispose();
        return;
      }
      await gameClient.start(keyboard);

      const loop = (_now: number): void => {
        if (!disposed) {
          gameClient.updateMirror();
          renderer.update(gameClient.mirror);
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };
      animFrameRef.current = requestAnimationFrame(loop);
    })().catch((err: unknown) => {
      console.error('[LocalSurface] start failed', err);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      keyboard.dispose();
      gameClient.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <Box sx={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', bgcolor: '#05070f' }}>
      <div ref={containerRef} data-testid="game-surface" style={{ width: '100%', height: '100%' }} />
      <Box sx={{ position: 'absolute', top: 16, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        <Typography variant="overline" sx={{ color: '#ff8800' }}>
          Single-Player Diagnostic — no network
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', color: '#888' }}>
          WASD to move. Three asteroids spawned nearby. If this jitters, the sim itself is bad.
        </Typography>
      </Box>
    </Box>
  );
}

export function App(): JSX.Element {
  const autoJoin = new URLSearchParams(window.location.search).has('room');
  const { user } = useAuthStore();
  const [phase, setPhase] = useState<'auth' | 'splash' | 'connecting' | 'game' | 'local'>(
    // Skip auth gate for E2E test auto-join URLs (?room=...) and if already authenticated.
    autoJoin || user ? (autoJoin ? 'game' : 'splash') : 'auth',
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // If user logs out while on splash, go back to auth.
  useEffect(() => {
    if (!user && phase !== 'auth' && phase !== 'game' && phase !== 'local') {
      setPhase('auth');
    }
  }, [user, phase]);

  const handleJoin = useCallback(() => {
    setPhase('game');
  }, []);

  const handleLocal = useCallback(() => {
    setPhase('local');
  }, []);

  const handleAuthSuccess = useCallback(() => {
    setPhase('splash');
  }, []);

  if (phase === 'game') {
    return (
      <>
        <AppHeader
          onLoginClick={() => setPhase('auth')}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <GameSurface />
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  }

  if (phase === 'local') {
    return <LocalSurface />;
  }

  if (phase === 'auth') {
    return (
      <>
        <AppHeader
          onLoginClick={() => {}}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <LoginPage onSuccess={handleAuthSuccess} onSkip={handleAuthSuccess} />
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </>
    );
  }

  return (
    <>
      <AppHeader
        onLoginClick={() => setPhase('auth')}
        onProfileClick={() => setProfileOpen(true)}
        onSettingsClick={openSettings}
      />
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          pt: '48px',
          bgcolor: '#05070f',
          gap: 3,
        }}
      >
        <Typography
          variant="h2"
          sx={{ color: '#00ff88', fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase' }}
        >
          EQX Peri
        </Typography>
        <Typography variant="subtitle1" sx={{ color: '#888' }}>
          Sector Alpha · Asteroids-class engagement zone
        </Typography>
        {phase === 'connecting' ? (
          <CircularProgress sx={{ color: '#00ff88' }} />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
            <Button
              variant="contained"
              size="large"
              onClick={handleJoin}
              sx={{
                bgcolor: '#00ff88',
                color: '#000',
                fontWeight: 700,
                px: 6,
                '&:hover': { bgcolor: '#00cc6a' },
              }}
            >
              Enter Sector Alpha
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={handleLocal}
              sx={{
                color: '#ff8800',
                borderColor: '#ff8800',
                '&:hover': { borderColor: '#ffaa33', bgcolor: 'rgba(255,136,0,0.1)' },
              }}
            >
              Single Player (Diagnostic)
            </Button>
          </Box>
        )}
      </Box>
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </>
  );
}
