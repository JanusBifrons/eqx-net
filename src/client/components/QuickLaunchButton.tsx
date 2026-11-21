/**
 * Join flow stage 7 — Quick launch (landing map only): one tap flies a
 * Fighter into the safest sector (no hostiles, else the fewest; busiest among
 * equals), as a guest when signed out.
 * The map's focus view follows the target while it glides (the glide is the
 * loading screen), then the Fighter launches through the same path as the
 * Hangar's LAUNCH. Extension point of `GalaxyPickerChrome`.
 */
import { useState } from 'react';
import { ButtonBase } from '@mui/material';
import { HUD } from '../hud/tokens';
import { getSector } from '../../core/galaxy/galaxy';
import { useAuthStore } from '../auth/authStore';
import { logEvent } from '../debug/ClientLogger';
import { FOCUS_GLIDE_MS } from '../render/galaxy/galaxyFocus';
import { quickLaunchSector, QUICK_LAUNCH_KIND } from './quickLaunch';
import type { ShipKindId } from '../../shared-types/shipKinds';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot';

/** Quick launch: a ghost cyan button (the mock-up's flow A, second button). */
const QUICK_LAUNCH_SX = {
  position: 'absolute',
  right: 'calc(12px + env(safe-area-inset-right, 0px))',
  bottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
  zIndex: 1,
  pointerEvents: 'auto',
  fontFamily: HUD.font.label,
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '.08em',
  px: '18px',
  minHeight: HUD.touchMin,
  borderRadius: '4px',
  color: HUD.color.auto,
  bgcolor: 'rgba(7,11,21,0.82)',
  border: '1px solid rgba(52,216,255,.55)',
  boxShadow: '0 0 12px rgba(52,216,255,.18)',
  whiteSpace: 'nowrap',
  '&:hover': { borderColor: HUD.color.auto, boxShadow: '0 0 16px rgba(52,216,255,.35)' },
  '&.Mui-disabled': { color: HUD.color.inkFaint, borderColor: HUD.color.edge2, boxShadow: 'none' },
} as const;

export interface QuickLaunchState {
  /** The sector the button would send a pilot to, or null (warp map / no feed yet). */
  readonly target: string | null;
  /** The sector it is gliding into, or null before the tap. */
  readonly launching: string | null;
  readonly launch: () => void;
}

export interface UseQuickLaunchOptions {
  isWarp: boolean;
  galaxyStats: readonly SectorLiveState[];
  /** The tap landed: the chrome clears its sector selection. */
  onStart: () => void;
  /** The glide finished: launch this hull into this sector. */
  onLaunch: (kind: ShipKindId, sector: string) => void;
}

export function useQuickLaunch({ isWarp, galaxyStats, onStart, onLaunch }: UseQuickLaunchOptions): QuickLaunchState {
  const [launching, setLaunching] = useState<string | null>(null);
  const target = isWarp ? null : quickLaunchSector(galaxyStats);
  const launch = (): void => {
    if (target === null || launching !== null) return;
    logEvent('quick_launch', { sector: target });
    // Signed out: Quick launch flies as a guest (sign-in is offered later).
    const auth = useAuthStore.getState();
    if (auth.user === null && !auth.guest) auth.continueAsGuest();
    onStart();
    setLaunching(target);
    const sector = target;
    window.setTimeout(() => onLaunch(QUICK_LAUNCH_KIND, sector), FOCUS_GLIDE_MS);
  };
  return { target, launching, launch };
}

export function QuickLaunchButton({ quick }: { quick: QuickLaunchState }): JSX.Element {
  const { target, launching, launch } = quick;
  return (
    <ButtonBase
      data-testid="galaxy-quick-launch"
      data-target={target ?? ''}
      disabled={target === null}
      aria-busy={launching !== null}
      onClick={launch}
      sx={QUICK_LAUNCH_SX}
    >
      {launching !== null ? `Warping into ${getSector(launching)?.name ?? launching}…` : 'QUICK LAUNCH ▸'}
    </ButtonBase>
  );
}
