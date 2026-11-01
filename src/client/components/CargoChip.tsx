/**
 * Living World P1a (plan peppy-jumping-pinwheel) — the cargo HUD chip.
 *
 * Top-left, under the shield/hull bar: `▣ 340/500  ¢1,250  ★1`. Amber at 80 %
 * full, red when full. Tap to expand a per-good breakdown. Below it, the short
 * pickup popups ("+7 Salvage · +30 cr") from the `loot_collected` accelerator.
 *
 * Reads only discrete Zustand state (cargo changes on a pickup / spill — never
 * per frame, invariant #2). Renders nothing while carrying nothing and no popup
 * is showing. `data-*` attrs are the E2E hook.
 */
import { useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { GOOD_DEFS, GOOD_IDS } from '../../shared-types/goods';
import { cargoFillState, cargoWeight } from '../net/lootView';

const FILL_COLOR = { ok: 'rgba(255,255,255,0.85)', high: '#ffbb33', full: '#ff4444' } as const;

const ROOT_SX = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '2px',
  fontFamily: 'system-ui, sans-serif',
  userSelect: 'none' as const,
};
const CHIP_SX = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: { xs: 0.75, sm: 1.25 },
  px: 0.75,
  py: '1px',
  borderRadius: '3px',
  backgroundColor: 'rgba(0,0,0,0.35)',
  fontSize: { xs: 10, sm: 14 },
  cursor: 'pointer',
  pointerEvents: 'auto' as const,
  width: 'fit-content',
};
const DETAIL_SX = {
  px: 0.75,
  fontSize: { xs: 9, sm: 12 },
  color: 'rgba(255,255,255,0.7)',
  pointerEvents: 'none' as const,
};
const DEPOSIT_TRACK_SX = {
  width: { xs: 64, sm: 140 },
  height: { xs: 3, sm: 5 },
  ml: 0.75,
  borderRadius: '2px',
  backgroundColor: 'rgba(255,255,255,0.12)',
  overflow: 'hidden' as const,
  pointerEvents: 'none' as const,
};
const DEPOSIT_FILL_SX = {
  height: '100%',
  backgroundColor: '#5fd6c4',
  transition: 'width 250ms linear',
};
const FEED_SX = {
  px: 0.75,
  fontSize: { xs: 9, sm: 12 },
  color: '#ffd060',
  pointerEvents: 'none' as const,
  textShadow: '0 0 4px rgba(0,0,0,0.9)',
};

export function CargoChip(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const cargo = useUIStore((s) => s.cargo);
  const capacity = useUIStore((s) => s.cargoCapacity);
  const feed = useUIStore((s) => s.lootFeed);
  const depositPct = useUIStore((s) => s.depositPct);
  const [open, setOpen] = useState(false);
  if (!shouldRender) return null;
  if (cargo === null && feed.length === 0) return null;

  const weight = Math.round(cargoWeight(cargo));
  const fill = cargoFillState(weight, capacity);
  return (
    <Box sx={ROOT_SX}>
      {cargo !== null && (
        <Box
          data-testid="cargo-chip"
          data-cargo-weight={weight}
          data-cargo-capacity={capacity}
          data-cargo-fill={fill}
          sx={CHIP_SX}
          onClick={() => setOpen((o) => !o)}
        >
          <span style={{ color: FILL_COLOR[fill] }}>▣ {weight}/{capacity}</span>
          {cargo.blueprints > 0 && <span style={{ color: '#ffc83a' }}>★{cargo.blueprints}</span>}
        </Box>
      )}
      {depositPct !== null && cargo !== null && (
        // Living World P1a-2 — auto-deposit progress (hold position by your
        // storage). The CSS transition smooths the 10 % steps.
        <Box data-testid="cargo-depositing" data-deposit-pct={depositPct} sx={DEPOSIT_TRACK_SX}>
          <Box sx={{ ...DEPOSIT_FILL_SX, width: `${depositPct}%` }} />
        </Box>
      )}
      {open && cargo !== null && (
        <Box data-testid="cargo-breakdown" sx={DETAIL_SX}>
          {GOOD_IDS.filter((id) => (cargo.goods[id] ?? 0) > 0).map((id) => (
            <div key={id}>{GOOD_DEFS[id].displayName} ×{cargo.goods[id]}</div>
          ))}
        </Box>
      )}
      {feed.map((e) => (
        <Box key={e.id} data-testid="loot-feed-line" sx={FEED_SX}>{e.text}</Box>
      ))}
    </Box>
  );
}
