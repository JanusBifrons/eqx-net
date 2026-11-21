import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { buildSectorBriefing, JOIN_GATE_COUNT, type JoinGateStep } from './sectorBriefing';

/**
 * The join loading screen's "sector briefing" body (WarpScreen, Idea A):
 * left, where you are arriving (name, holder, four live facts) over a slim
 * progress bar filled by the REAL join gates, the current step's name and
 * plain explainer, and the step list (done / current / waiting); right, a
 * slow radar sweep.
 * Mounted by WarpScreen only while the screen is visible, so its store
 * subscriptions and the CSS sweep cost nothing in play. No RAF, no timers:
 * the sweep is a CSS keyframe (off under `prefers-reduced-motion`), the bar
 * a CSS transform on a precomputed sx per gate count.
 */

const HUD = '#cfe3f7';
const HUD_DIM = '#7d93ab';
const CYAN = '#4fd2ff';
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
  maxWidth: 320,
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
const TRACK_SX = {
  height: 3,
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.1)',
  overflow: 'hidden',
  mt: 0.75,
};
/** One sx per gate count, so a gate flip swaps a stable reference. */
const FILL_SX: readonly object[] = Array.from({ length: JOIN_GATE_COUNT + 1 }, (_, i) => ({
  height: '100%',
  bgcolor: CYAN,
  transformOrigin: 'left center',
  transform: `scaleX(${i / JOIN_GATE_COUNT})`,
  transition: 'transform 300ms ease-out',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
}));
const STATUS_ROW_SX = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1, minWidth: 0 };
const COUNT_SX = { color: HUD_DIM, fontFamily: MONO, fontSize: 9, lineHeight: 1.3, flex: '0 0 auto' };
const DETAIL_SX = { color: HUD, fontSize: 10, lineHeight: 1.3, mt: -0.5 };
const STEPS_SX = { listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column' as const, gap: '1px' };
const STEP_BASE_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  fontSize: 9,
  lineHeight: 1.3,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
type StepState = 'done' | 'current' | 'waiting';
const STEP_SX: Record<StepState, object> = {
  done: { ...STEP_BASE_SX, color: HUD_DIM },
  current: { ...STEP_BASE_SX, color: CYAN, fontWeight: 700 },
  waiting: { ...STEP_BASE_SX, color: 'rgba(125,147,171,0.5)' },
};
const STEP_MARK: Record<StepState, string> = { done: '✓', current: '▸', waiting: '·' };
const MARK_SX = { width: 8, flex: '0 0 auto', textAlign: 'center' as const, fontFamily: MONO };
const RADAR_SX = {
  flex: '0 0 auto',
  width: { xs: 'min(34vw, 46vh)', sm: 'min(30vw, 52vh)' },
  maxWidth: 260,
  aspectRatio: '1',
  '& svg': { width: '100%', height: '100%', display: 'block' },
  '& .eqx-radar-sweep': {
    transformOrigin: '50px 50px',
    animation: 'eqx-radar-spin 4s linear infinite',
  },
  '@keyframes eqx-radar-spin': { to: { transform: 'rotate(360deg)' } },
  '@media (prefers-reduced-motion: reduce)': {
    '& .eqx-radar-sweep': { animation: 'none' },
  },
};
/** Hidden (in play): the sweep is paused, so it costs no style/compositor work. */
const RADAR_SX_PAUSED = {
  ...RADAR_SX,
  '& .eqx-radar-sweep': { ...RADAR_SX['& .eqx-radar-sweep'], animationPlayState: 'paused' },
};

export interface WarpBriefingProps {
  /** The sector being joined, or null when unknown (non-galaxy rooms). */
  sectorKey: string | null;
  /** Join gates done (0..JOIN_GATE_COUNT), from `joinGatesDone`. */
  gatesDone: number;
  /** The ordered loading steps, from `joinGateSteps` (the same checks). */
  steps: readonly JoinGateStep[];
  /** Index of the step in progress, or -1 when all are done. */
  currentStep: number;
  /** The screen is showing: false pauses the radar sweep. */
  active: boolean;
  /** The status label element (WarpScreen owns its text + testid). */
  status: JSX.Element;
  /** Under the status: the stall line + Cancel, or null. */
  footer: JSX.Element | null;
}

export function WarpBriefing({ sectorKey, gatesDone, steps, currentStep, active, status, footer }: WarpBriefingProps): JSX.Element {
  const galaxyStats = useUIStore((s) => s.galaxyStats);
  const shipRoster = useUIStore((s) => s.shipRoster);
  const brief = buildSectorBriefing(sectorKey, galaxyStats, shipRoster);
  const done = Math.max(0, Math.min(JOIN_GATE_COUNT, gatesDone));
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
        <Box
          sx={TRACK_SX}
          data-testid="warp-screen-progress"
          data-gates-done={done}
          data-gates-total={JOIN_GATE_COUNT}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={JOIN_GATE_COUNT}
          aria-valuenow={done}
        >
          <Box sx={FILL_SX[done]} />
        </Box>
        <Box sx={STATUS_ROW_SX}>
          {status}
          <Typography data-testid="warp-step-count" sx={COUNT_SX}>
            {`${steps.filter((st) => st.done).length} of ${steps.length}`}
          </Typography>
        </Box>
        {currentStep >= 0 && (
          <Typography data-testid="warp-step-detail" sx={DETAIL_SX}>{steps[currentStep]!.detail}</Typography>
        )}
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
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <Box component="span" sx={MARK_SX} aria-hidden="true">{STEP_MARK[state]}</Box>
                {st.name}
              </Box>
            );
          })}
        </Box>
        {footer}
      </Box>
      <Box sx={active ? RADAR_SX : RADAR_SX_PAUSED} data-testid="warp-briefing-radar" data-blips={brief?.blips.length ?? 0}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(79,210,255,0.2)" />
          <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(79,210,255,0.13)" />
          <circle cx="50" cy="50" r="14" fill="none" stroke="rgba(79,210,255,0.13)" />
          <path className="eqx-radar-sweep" d="M50 50 L50 4 A46 46 0 0 1 82 17 Z" fill="rgba(79,210,255,0.13)" />
          {brief?.blips.map((b) => (
            <circle key={b.id} cx={b.cx} cy={b.cy} r="2" fill="#5fd38a" />
          ))}
          <circle cx="50" cy="50" r="1.6" fill="#fff" />
        </svg>
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
