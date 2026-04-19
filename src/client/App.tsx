import { useState, useEffect, useRef, useCallback } from 'react';
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
import { loadStoredPlayerId, persistPlayerId } from './identity/token';
import { useUIStore } from './state/store';

const SERVER_URL = import.meta.env['VITE_WS_URL'] ?? 'http://localhost:5173';

function HUD(): JSX.Element {
  const { connectionStatus, sectorName, hullPct, ammo, sectorAlert, playerId, shipCount } =
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
    </Box>
  );
}

function GameSurface(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ColyseusGameClient | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const animFrameRef = useRef<number>(0);
  const { setConnectionStatus, setPlayerId, setSectorName } = useUIStore();

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

    (async () => {
      await renderer.init(el);

      // StrictMode fires cleanup before the async init resolves. If disposal
      // happened while we were awaiting, tear down the just-initialised renderer
      // (which appended a canvas) and exit — the second mount will take over.
      if (disposed) {
        renderer.dispose();
        return;
      }

      const loop = (): void => {
        if (!disposed) {
          renderer.update(gameClient.mirror);
          const localId = gameClient.mirror.localPlayerId;
          const localShip = localId ? gameClient.mirror.ships.get(localId) : null;
          if (localShip) {
            el.dataset['shipX'] = localShip.x.toFixed(3);
            el.dataset['shipY'] = localShip.y.toFixed(3);
            el.dataset['shipAngle'] = localShip.angle.toFixed(4);
          }
          animFrameRef.current = requestAnimationFrame(loop);
        }
      };
      animFrameRef.current = requestAnimationFrame(loop);

      const storedId = loadStoredPlayerId();
      await gameClient.connect(SERVER_URL, storedId, keyboard, {
        onConnectionStatus: setConnectionStatus,
        onPlayerId: (id) => {
          persistPlayerId(id);
          setPlayerId(id);
        },
      });

      setSectorName('Sector Alpha');
    })().catch((err: unknown) => {
      console.error('[GameSurface] connection failed', err);
      setConnectionStatus('error');
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      keyboard.dispose();
      gameClient.dispose();
      renderer.dispose();
    };
  }, [setConnectionStatus, setPlayerId, setSectorName]);

  return (
    <Box sx={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', bgcolor: '#05070f' }}>
      <div ref={containerRef} data-testid="game-surface" style={{ width: '100%', height: '100%' }} />
      <HUD />
    </Box>
  );
}

export function App(): JSX.Element {
  const [phase, setPhase] = useState<'splash' | 'connecting' | 'game'>('splash');

  const handleJoin = useCallback(() => {
    setPhase('game');
  }, []);

  if (phase === 'game') {
    return <GameSurface />;
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
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
      )}
    </Box>
  );
}
