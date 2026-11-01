/**
 * Economy v2 W3 — the Research Lab panel, shown in the inspector for the
 * pilot's OWN built Research Lab. Rebuilt ONLY from the server's `lab_state`
 * replies (#16): it asks on mount and every second while it's on screen.
 *
 * Tap blueprints to select them:
 *  - one ORIGINAL ⇒ Research materials / Research output / Copy ×1·×5·×10;
 *  - three of the same product (all originals or all copies) ⇒ Combine.
 * Fees and times come from the same pure rules the server runs
 * (`shared-types/research.ts`). Names only, never ids.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import { sendLabCancel, sendLabQuery, sendLabStart } from '../net/tradeClient';
import {
  COMBINE_COUNT, COMBINE_FEE, COMBINE_PULSES, RESEARCH_MAX, RESEARCH_STEP,
  copyFee, copyPulses, researchFee, researchLevel, researchPulses, type ResearchStat,
} from '../../shared-types/research';
import type { LabBlueprintView } from '../../shared-types/messages/labMessages';

export const LAB_POLL_MS = 1000;
/** How long an action's verdict stays on the panel. */
export const LAB_NOTICE_MS = 4000;
const COPY_RUN_CHOICES = [1, 5, 10] as const;

const ROOT_SX = { mt: 0.5, pointerEvents: 'auto' as const, fontSize: 10, color: '#dcd4ff', maxWidth: 240 };
const TITLE_SX = { fontSize: 10, fontWeight: 700, color: '#b9a6ff', mb: '2px' };
const LIST_SX = { display: 'flex', flexDirection: 'column' as const, gap: '2px', maxHeight: 120, overflowY: 'auto' as const };
const ROW_SX = {
  px: 0.5, py: '1px', borderRadius: '3px', cursor: 'pointer', userSelect: 'none' as const,
  border: '1px solid rgba(155,123,255,0.35)', backgroundColor: 'rgba(20,12,40,0.6)',
};
const ROW_SELECTED_SX = { ...ROW_SX, border: '1px solid #b9a6ff', backgroundColor: 'rgba(80,50,160,0.55)' };
const ACTIONS_SX = { display: 'flex', flexWrap: 'wrap' as const, gap: '3px', mt: '3px' };
const BTN_SX = {
  px: 0.75, py: '2px', borderRadius: '3px', cursor: 'pointer', userSelect: 'none' as const,
  border: '1px solid rgba(185,166,255,0.8)', color: '#efeaff', backgroundColor: 'rgba(60,40,120,0.6)', fontSize: 10,
};
const BAR_SX = { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', my: '2px' };
const WARN_SX = { color: '#ffb36b' };

function stars(quality: number): string {
  const n = Math.max(0, Math.min(5, Math.round(quality / 20)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** "Original" or "Copy · 4 runs". */
function kindLine(b: LabBlueprintView): string {
  if (b.kind === 'bpo') return 'Original';
  return `Copy · ${b.runs ?? 0} run${b.runs === 1 ? '' : 's'}`;
}

/** "3 min" / "45 s" for N 1 Hz pulses. */
export function pulsesLabel(n: number): string {
  return n >= 120 ? `${Math.round(n / 60)} min` : `${n} s`;
}

export const ResearchLabPanel = memo(function ResearchLabPanel({ entityId }: { entityId: number }): JSX.Element {
  const state = useUIStore((s) => (s.labState?.entityId === entityId ? s.labState : null));
  const [selected, setSelected] = useState<string[]>([]);

  // An action's verdict rides one reply; the next poll has none. Hold it.
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state?.message === undefined) return;
    setNotice({ ok: state.ok === true, message: state.message });
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), LAB_NOTICE_MS);
  }, [state]);
  useEffect(() => () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    sendLabQuery(entityId);
    const t = setInterval(() => sendLabQuery(entityId), LAB_POLL_MS);
    return () => clearInterval(t);
  }, [entityId]);

  // Drop selections whose blueprint has left storage.
  const blueprints = state?.blueprints ?? [];
  const chosen = selected.map((u) => blueprints.find((b) => b.uid === u)).filter((b): b is LabBlueprintView => b !== undefined);

  const toggle = (uid: string): void => {
    setSelected((cur) => (cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid].slice(-COMBINE_COUNT)));
  };
  const start = (job: Parameters<typeof sendLabStart>[1]): void => {
    sendLabStart(entityId, job);
    setSelected([]);
  };

  const one = chosen.length === 1 ? chosen[0]! : null;
  const canCombine = chosen.length === COMBINE_COUNT
    && chosen.every((b) => b.product === chosen[0]!.product && b.kind === chosen[0]!.kind);

  const researchBtn = (bp: LabBlueprintView, stat: ResearchStat, label: string): JSX.Element | null => {
    if (bp[stat] + RESEARCH_STEP[stat] > RESEARCH_MAX[stat]) return null;
    const level = researchLevel(bp, stat);
    return (
      <Box sx={BTN_SX} data-testid={`lab-research-${stat}`} onClick={() => start({ kind: 'research', stat, uid: bp.uid })}>
        {label} · {researchFee(level)}¢ · {pulsesLabel(researchPulses(level))}
      </Box>
    );
  };

  return (
    <Box sx={ROOT_SX} data-testid="research-lab-panel">
      <Box sx={TITLE_SX}>Research Lab</Box>
      {state === null && <Box>Loading…</Box>}
      {state !== null && !state.powered && <Box sx={WARN_SX} data-testid="lab-unpowered">Unpowered: jobs are paused.</Box>}
      {state !== null && !state.connected && <Box sx={WARN_SX}>Connect the lab to your base storage.</Box>}
      {state?.job != null && (
        <Box data-testid="lab-job" data-done={state.job.done} data-pulses={state.job.pulses}>
          <Box>{state.job.label}</Box>
          <Box sx={BAR_SX}>
            <Box sx={{ height: '100%', width: `${Math.round((state.job.done / state.job.pulses) * 100)}%`, backgroundColor: '#b9a6ff' }} />
          </Box>
          <Box sx={ACTIONS_SX}>
            <Box component="span">{pulsesLabel(state.job.pulses - state.job.done)} left</Box>
            <Box sx={BTN_SX} data-testid="lab-cancel" onClick={() => sendLabCancel(entityId)}>Cancel</Box>
          </Box>
        </Box>
      )}
      {state !== null && state.job === null && (
        <>
          {blueprints.length === 0
            ? <Box>No blueprints in this base yet.</Box>
            : (
              <Box sx={LIST_SX}>
                {blueprints.map((b) => (
                  <Box
                    key={b.uid}
                    sx={selected.includes(b.uid) ? ROW_SELECTED_SX : ROW_SX}
                    data-testid="lab-bp"
                    data-uid={b.uid}
                    onClick={() => toggle(b.uid)}
                  >
                    {b.name} {stars(b.quality)} · {kindLine(b)} · −{b.material}% mats · Q{b.output}
                  </Box>
                ))}
              </Box>
            )}
          {one !== null && one.kind === 'bpo' && (
            <Box sx={ACTIONS_SX}>
              {researchBtn(one, 'material', 'Research materials')}
              {researchBtn(one, 'output', 'Research output')}
              {COPY_RUN_CHOICES.map((n) => (
                <Box key={n} sx={BTN_SX} data-testid={`lab-copy-${n}`} onClick={() => start({ kind: 'copy', uid: one.uid, runs: n })}>
                  Copy ×{n} · {copyFee(n)}¢ · {pulsesLabel(copyPulses(n))}
                </Box>
              ))}
            </Box>
          )}
          {canCombine && (
            <Box sx={ACTIONS_SX}>
              <Box sx={BTN_SX} data-testid="lab-combine" onClick={() => start({ kind: 'combine', uids: chosen.map((b) => b.uid) })}>
                Combine 3 · {COMBINE_FEE}¢ · {pulsesLabel(COMBINE_PULSES)}
              </Box>
            </Box>
          )}
          {blueprints.length > 0 && chosen.length === 0 && (
            <Box sx={{ opacity: 0.7, mt: '2px' }}>Tap an original to research or copy it, or 3 matching blueprints to combine.</Box>
          )}
        </>
      )}
      {notice !== null && (
        <Box data-testid="lab-message" sx={{ mt: '2px', color: notice.ok ? '#9be59b' : '#ff8a8a' }}>{notice.message}</Box>
      )}
    </Box>
  );
});
