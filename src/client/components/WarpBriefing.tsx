import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { buildSectorBriefing, LOADING_QUIPS, type JoinGateStep } from './sectorBriefing';
import { LoadingSigil } from './LoadingSigil';

/**
 * The join loading screen's "sector briefing" body (WarpScreen, Idea A):
 * left, where you are arriving (name, holder, four live facts), one fun line
 * that cycles in a fixed spot (proof the screen is alive), the progress bar
 * (the whole load, %), and the step list: each step named for what the game
 * is really doing, with its own % (the art bake counts real textures) and a
 * green tick when done. Right, the pilot's faction sigil with a shimmer.
 * Mounted by WarpScreen only while the screen is visible, so its store
 * subscriptions and CSS animations cost nothing in play. No RAF, no timers:
 * the quips and the shimmer are CSS keyframes (still under
 * `prefers-reduced-motion`), the bar a CSS transform on a precomputed sx.
 */

const HUD = '#cfe3f7';
const HUD_DIM = '#7d93ab';
const CYAN = '#4fd2ff';
const GREEN = '#5fd38a';
const MONO = 'ui-monospace, "Roboto Mono", monospace';

const ROOT_SX = {
  display: 'flex',
  flexDirection: 'row' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: { xs: 3, sm: 6 },
  width: '100%',
  maxWidth: 760,
  px: 3,
  boxSizing: 'border-box' as const,
};
const LEFT_SX = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 0.75,
  flex: '1 1 0',
  minWidth: 0,
  maxWidth: 340,
};
const LABEL_SX = {
  color: HUD_DIM,
  fontSize: 9,
  letterSpacing: 2,
  textTransform: 'uppercase' as const,
  lineHeight: 1.3,
};
const NAME_SX = {
  color: HUD,
  fontWeight: 700,
  fontSize: { xs: 22, sm: 28 },
  letterSpacing: 0.5,
  lineHeight: 1,
  textTransform: 'uppercase' as const,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const OWNER_ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 };
const OWNER_TEXT_SX = { color: HUD, fontSize: 11, lineHeight: 1.3, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' };
const SIGIL_BASE_SX = { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto' };
const GRID_SX = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  columnGap: 1.75,
  rowGap: 0.5,
  mt: 0.25,
};
const FACT_VALUE_SX = { color: '#fff', fontFamily: MONO, fontSize: 12, fontWeight: 600, lineHeight: 1.25 };

/** Each quip shows for QUIP_S seconds, one after another, in one grid cell. */
const QUIP_S = 2.4;
const QUIP_CYCLE_S = QUIP_S * LOADING_QUIPS.length;
const QUIP_SHARE = 100 / LOADING_QUIPS.length;
const QUIPS_SX = {
  display: 'grid',
  mt: 0.75,
  '& > span': {
    gridArea: '1 / 1',
    fontSize: 12,
    fontStyle: 'italic',
    fontWeight: 600,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'transparent',
    background: `linear-gradient(90deg, ${HUD_DIM} 0%, ${HUD_DIM} 40%, #ffffff 50%, ${HUD_DIM} 60%, ${HUD_DIM} 100%)`,
    backgroundSize: '300% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    opacity: 0,
    animation: `eqx-quip ${QUIP_CYCLE_S}s linear infinite, eqx-quip-shine 1.6s linear infinite`,
  },
  '@keyframes eqx-quip': {
    '0%': { opacity: 0, transform: 'translateY(5px)' },
    [`${(QUIP_SHARE * 0.12).toFixed(2)}%`]: { opacity: 1, transform: 'none' },
    [`${(QUIP_SHARE * 0.85).toFixed(2)}%`]: { opacity: 1, transform: 'none' },
    [`${QUIP_SHARE.toFixed(2)}%`]: { opacity: 0, transform: 'translateY(-5px)' },
    '100%': { opacity: 0 },
  },
  '@keyframes eqx-quip-shine': { from: { backgroundPosition: '100% 0' }, to: { backgroundPosition: '0% 0' } },
  '@media (prefers-reduced-motion: reduce)': {
    '& > span': { animation: 'none' },
    '& > span:first-of-type': { opacity: 1 },
  },
};
/** Per-quip delay sx, built once. */
const QUIP_DELAY_STYLE: readonly { animationDelay: string }[] = LOADING_QUIPS.map((_, i) => ({
  animationDelay: `${i * QUIP_S}s, 0s`,
}));

const TRACK_SX = {
  height: 4,
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.1)',
  overflow: 'hidden',
};
/** One sx per whole percent, so a progress change swaps a stable reference. */
const FILL_SX: readonly object[] = Array.from({ length: 101 }, (_, i) => ({
  height: '100%',
  bgcolor: CYAN,
  transformOrigin: 'left center',
  transform: `scaleX(${i / 100})`,
  transition: 'transform 300ms ease-out',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
}));
const STATUS_ROW_SX = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1, minWidth: 0, mt: 0.25 };
const PCT_SX = { color: HUD, fontFamily: MONO, fontSize: 10, fontWeight: 700, lineHeight: 1.3, flex: '0 0 auto' };
const STEPS_SX = { listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column' as const, gap: '2px' };
const STEP_BASE_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  fontSize: 10,
  lineHeight: 1.35,
  minWidth: 0,
};
type StepState = 'done' | 'current' | 'waiting';
const STEP_SX: Record<StepState, object> = {
  done: { ...STEP_BASE_SX, color: GREEN },
  current: { ...STEP_BASE_SX, color: CYAN, fontWeight: 700 },
  waiting: { ...STEP_BASE_SX, color: 'rgba(125,147,171,0.55)' },
};
const STEP_MARK: Record<StepState, string> = { done: '✓', current: '▸', waiting: '·' };
const MARK_SX = { width: 10, flex: '0 0 auto', textAlign: 'center' as const, fontFamily: MONO };
const STEP_NAME_SX = { flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' };
const STEP_PCT_SX = { flex: '0 0 auto', fontFamily: MONO, fontSize: 9, textAlign: 'right' as const, minWidth: 30 };
const EMBLEM_SX = {
  flex: '0 0 auto',
  position: 'relative' as const,
  width: { xs: 'min(30vw, 42vh)', sm: 'min(26vw, 46vh)' },
  maxWidth: 220,
  aspectRatio: '1',
  '& .eqx-sigil-img, & .eqx-sigil-shimmer': { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  '& .eqx-sigil-img': { objectFit: 'contain', filter: 'drop-shadow(0 0 12px rgba(79,210,255,0.25))' },
  '& .eqx-sigil-shimmer': {
    background: 'linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.6) 50%, transparent 65%)',
    backgroundSize: '250% 100%',
    animation: 'eqx-sigil-shimmer 3.2s ease-in-out infinite',
  },
  '@keyframes eqx-sigil-shimmer': {
    '0%': { backgroundPosition: '120% 0' },
    '60%, 100%': { backgroundPosition: '-20% 0' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    '& .eqx-sigil-shimmer': { animation: 'none', opacity: 0 },
  },
};

export interface WarpBriefingProps {
  /** The sector being joined, or null when unknown (non-galaxy rooms). */
  sectorKey: string | null;
  /** The whole load, 0..100, from `joinOverallPct`. */
  overallPct: number;
  /** The ordered loading steps, from `joinGateSteps`. */
  steps: readonly JoinGateStep[];
  /** Index of the step in progress, or -1 when all are done. */
  currentStep: number;
  /** The status label element (WarpScreen owns its text + testid). */
  status: JSX.Element;
  /** Under the steps: the stall line + Cancel, or null. */
  footer: JSX.Element | null;
}

export function WarpBriefing({ sectorKey, overallPct, steps, currentStep, status, footer }: WarpBriefingProps): JSX.Element {
  const galaxyStats = useUIStore((s) => s.galaxyStats);
  const playerId = useUIStore((s) => s.playerId);
  const brief = buildSectorBriefing(sectorKey, galaxyStats);
  const pct = Math.max(0, Math.min(100, Math.floor(overallPct)));
  return (
    <Box sx={ROOT_SX} data-testid="warp-briefing" data-sector-key={sectorKey ?? ''}>
      <Box sx={LEFT_SX}>
        {brief && (
          <>
            <Typography sx={LABEL_SX}>Arriving at</Typography>
            <Typography data-testid="warp-briefing-name" sx={NAME_SX}>{brief.name}</Typography>
            <Box sx={OWNER_ROW_SX}>
              <Box
                component="span"
                data-testid="warp-briefing-sigil"
                sx={{ ...SIGIL_BASE_SX, bgcolor: brief.ownerColor, boxShadow: brief.held ? `0 0 6px ${brief.ownerColor}` : 'none' }}
              />
              <Typography data-testid="warp-briefing-owner" sx={OWNER_TEXT_SX}>{brief.ownerLine}</Typography>
            </Box>
            <Box sx={GRID_SX}>
              {brief.facts.map((f) => (
                <Box key={f.id} data-testid={`warp-briefing-fact-${f.id}`}>
                  <Typography sx={LABEL_SX}>{f.label}</Typography>
                  <Typography sx={FACT_VALUE_SX}>{f.value}</Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
        <Box sx={QUIPS_SX} data-testid="warp-quips" aria-hidden="true">
          {LOADING_QUIPS.map((q, i) => (
            <span key={q} style={QUIP_DELAY_STYLE[i]}>{q}…</span>
          ))}
        </Box>
        <Box
          sx={TRACK_SX}
          data-testid="warp-screen-progress"
          data-pct={pct}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <Box sx={FILL_SX[pct]} />
        </Box>
        <Box sx={STATUS_ROW_SX}>
          {status}
          <Typography data-testid="warp-overall-pct" sx={PCT_SX}>{pct}%</Typography>
        </Box>
        <Box component="ol" sx={STEPS_SX} data-testid="warp-steps" aria-label="Loading steps">
          {steps.map((st, i) => {
            const state: StepState = st.done ? 'done' : i === currentStep ? 'current' : 'waiting';
            return (
              <Box
                component="li"
                key={st.id}
                sx={STEP_SX[state]}
                data-testid={`warp-step-${st.id}`}
                data-step-id={st.id}
                data-step-state={state}
                data-step-pct={st.pct}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <Box component="span" sx={MARK_SX} aria-hidden="true">{STEP_MARK[state]}</Box>
                <Box component="span" sx={STEP_NAME_SX}>{i + 1}. {st.name}</Box>
                <Box component="span" sx={STEP_PCT_SX}>{st.pct}%</Box>
              </Box>
            );
          })}
        </Box>
        {footer}
      </Box>
      <Box sx={EMBLEM_SX} data-testid="warp-briefing-emblem" aria-hidden="true">
        <LoadingSigil playerId={playerId} />
      </Box>
    </Box>
  );
}

/** The status label: the current step's name (WarpScreen owns the text). */
export const WARP_STATUS_SX = {
  color: HUD,
  fontSize: 9,
  letterSpacing: 2,
  textTransform: 'uppercase' as const,
  lineHeight: 1.3,
  minWidth: 0,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
