/**
 * Single-player diagnostic surface (`?phase=local`).
 *
 * Runs the same Pixi renderer against `LocalGameClient` (no Colyseus
 * connection) so we can A/B the renderer against a deterministic sim
 * — if this jitters, the issue is in the renderer or the device, not
 * the network. Three asteroids spawn near the player; WASD moves.
 *
 * Lives separately from `GameSurface` because the contracts are
 * different (no transit, no warp, no roster, no overlays) and trying
 * to share state-management between the two flows leaks asteroid /
 * snapshot / interest-grid concerns into the diagnostic surface.
 */

import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { PixiRenderer } from '../render/PixiRenderer';
import { Keyboard } from '../input/Keyboard';
import { LocalGameClient } from '../local/LocalGameClient';
import { logEvent } from '../debug/ClientLogger';

export function LocalSurface(): JSX.Element {
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
      logEvent('local_surface_start_failed', { err: String(err) });
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
