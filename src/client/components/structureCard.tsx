/**
 * The inspector's compact building card (building-panels redesign A2).
 *
 * Row 1: the structure badge, name, "Lv N", a short hull bar, a power icon
 * coloured by state (energy gold OK, danger red short, grey off) and ONE
 * status chip (building %, breach / no fuel / no munitions, or the production
 * state). Row 2, only for a building that makes things: a mini slot with what
 * it is making and the cycle's progress (`prodFrac`).
 *
 * Detail (power numbers, recipe, blueprint, connections, hold, management)
 * lives in the settings side panel (StructureSettingsModal.tsx); the card
 * reuses the same helpers: `inspectorPowerLine` for the power label and
 * `prodStatusLine` for the production state.
 */
import { Box, CircularProgress, Tooltip } from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';
import { EntityBadge } from './EntityBadge';
import { Bar } from './inspectorBar';
import { phoneTiny } from './inspectorSizes';
import { inspectorPowerLine } from './structureSettingsPower';
import { HUD, hullColor } from '../hud/tokens';
import { BUILD_AWAITING_CLEAR_LINE } from '../structures/buildAwaitingClear';
import { PROD_STATE } from '@shared-types/production';
import { RECIPES, type RecipeId } from '@shared-types/recipes';

/** The card fields (a subset of the inspector's polled data). */
export interface StructureCardData {
  name: string;
  hpPct: number;
  pending?: boolean;
  level?: number;
  owner?: string;
  selfPower?: number;
  powered?: boolean;
  built?: boolean;
  switchedOff?: boolean;
  buildPct?: number;
  buildBlocked?: boolean;
  breach?: boolean;
  noFuel?: boolean;
  noAmmo?: boolean;
  recipe?: RecipeId;
  /** The raw production state (`PROD_STATE`) and its label (`prodStatusLine`). */
  prodState?: number;
  prodStatus?: string;
  /** A building that makes things (`makesThings`): shows row 2. */
  makes?: boolean;
  /** The loaded cycle's progress, 0..100 (absent: nothing loaded). */
  prodPct?: number;
}

export type PowerIconState = 'ok' | 'short' | 'off';

/** The power icon's state, or null for a passive relay (no gen, no draw). */
export function powerIconState(d: Pick<StructureCardData, 'selfPower' | 'powered' | 'built' | 'switchedOff'>): PowerIconState | null {
  if (d.selfPower === undefined) return null;
  if (d.switchedOff === true) return 'off';
  if (d.selfPower === 0) return null;
  if (d.selfPower > 0) return 'ok';
  if (d.built !== true) return 'off';
  return d.powered === true ? 'ok' : 'short';
}

export type ChipTone = 'danger' | 'warn' | 'build' | 'ok' | 'dim';
export interface StatusChip { key: string; label: string; tone: ChipTone; title?: string }

const PROD_TONE: Readonly<Record<number, ChipTone>> = {
  [PROD_STATE.running]: 'ok',
  [PROD_STATE.unpowered]: 'danger',
  [PROD_STATE.done]: 'dim',
};

/** The card's one status chip, most urgent first; null when there is nothing to say. */
export function structureStatusChip(d: StructureCardData): StatusChip | null {
  if (d.breach === true) return { key: 'breach', label: 'Breach', tone: 'danger', title: 'Someone is breaking in' };
  if (d.buildPct !== undefined && d.buildPct < 1) return { key: 'building', label: `Building ${Math.round(d.buildPct * 100)}%`, tone: 'build' };
  if (d.buildBlocked === true) return { key: 'build-blocked', label: BUILD_AWAITING_CLEAR_LINE, tone: 'warn' };
  if (d.noFuel === true) return { key: 'no-fuel', label: 'No fuel', tone: 'danger' };
  if (d.noAmmo === true) return { key: 'no-ammo', label: 'No munitions', tone: 'danger' };
  if (d.prodStatus) return { key: 'production', label: d.prodStatus, tone: PROD_TONE[d.prodState ?? 0] ?? 'warn' };
  return null;
}

const C = HUD.color;
const POWER_COLOR: Readonly<Record<PowerIconState, string>> = { ok: C.energy, short: C.danger, off: C.inkFaint };
const TONE_COLOR: Readonly<Record<ChipTone, string>> = {
  danger: C.danger, warn: C.hullWarn, build: C.energy, ok: C.hullOk, dim: C.inkDim,
};

export function StructureCardRows({ d }: { d: StructureCardData }): JSX.Element {
  const power = powerIconState(d);
  const powerLabel = power === null ? '' : d.switchedOff === true ? 'OFF' : inspectorPowerLine(d.selfPower!, d.powered, d.built);
  const chip = structureStatusChip(d);
  return (
    <>
      <Box sx={ROW_SX} data-testid="entity-stats-card">
        <EntityBadge kind="structure" size={12} />
        <Box sx={NAME_SX} data-testid="entity-stats-name">{d.name}</Box>
        {d.level !== undefined && <Box sx={LEVEL_SX} data-testid="entity-stats-level">{`Lv ${d.level}`}</Box>}
        {d.pending ? (
          <Box data-testid="entity-stats-spinner" sx={SPIN_BOX_SX}><CircularProgress size={10} thickness={6} sx={SPINNER_SX} /></Box>
        ) : (
          <Bar pct={d.hpPct} color={hullColor(d.hpPct)} short />
        )}
        {power !== null && (
          // Desktop hover only (touch never opens it). The icon ignores the
          // pointer so its SVG <title> (the accessible label) shows no second,
          // native tooltip; the span takes the hover.
          <Tooltip title={`Power: ${powerLabel}`} describeChild disableTouchListener>
            <Box component="span" sx={HOVER_SX}>
              <BoltIcon
                data-testid="entity-stats-power" data-power-state={power} titleAccess={powerLabel}
                sx={POWER_SX} style={{ color: POWER_COLOR[power] }}
              />
            </Box>
          </Tooltip>
        )}
        {chip !== null && (
          <Tooltip title={chip.title ?? chip.label} describeChild disableTouchListener>
            <Box sx={CHIP_SX} data-testid="entity-stats-status" data-status={chip.key}
              style={{ color: TONE_COLOR[chip.tone], borderColor: TONE_COLOR[chip.tone] }}>
              {chip.label}
            </Box>
          </Tooltip>
        )}
        {d.owner !== undefined && <Box sx={OWNER_SX} data-testid="entity-stats-owner">{d.owner}</Box>}
      </Box>
      {d.makes === true && d.recipe !== undefined && (
        <Box sx={SLOT_SX} data-testid="entity-stats-making" data-recipe={d.recipe} data-prod-pct={d.prodPct ?? 0}>
          <Box sx={SLOT_FILL_SX} style={{ width: `${d.prodPct ?? 0}%` }} />
          <Box component="span" sx={SLOT_LABEL_SX}>{RECIPES[d.recipe].displayName}</Box>
        </Box>
      )}
    </>
  );
}

const TEXT_8 = phoneTiny({ fontSize: [8, 16] });
const ROW_SX = { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' as const } as const;
const NAME_SX = { ...phoneTiny({ fontSize: [10, 20] }), fontWeight: 700, color: '#cde', letterSpacing: 0.3 };
const LEVEL_SX = { ...TEXT_8, fontWeight: 700, color: C.inkDim, fontFamily: HUD.font.num };
const OWNER_SX = { ...TEXT_8, color: C.inkDim, ml: 'auto' };
const POWER_SX = { ...phoneTiny({ fontSize: [12, 22] }), pointerEvents: 'none' as const };
const HOVER_SX = { display: 'inline-flex', alignItems: 'center' } as const;
const CHIP_SX = {
  ...TEXT_8, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' as const,
  border: '1px solid', borderRadius: '3px', px: '3px', lineHeight: 1.3,
};
const SPIN_BOX_SX = { display: 'flex', alignItems: 'center' };
const SPINNER_SX = { color: 'rgba(180,220,255,0.8)' };
const SLOT_SX = {
  gridColumn: '1 / -1', position: 'relative' as const, overflow: 'hidden' as const,
  border: `1px solid ${C.edge2}`, borderRadius: '3px', bgcolor: C.cell, px: '4px', py: '1px',
};
const SLOT_FILL_SX = {
  position: 'absolute' as const, left: 0, top: 0, bottom: 0,
  bgcolor: 'rgba(52,216,255,0.22)', transition: 'width 1000ms linear',
};
const SLOT_LABEL_SX = { ...TEXT_8, position: 'relative' as const, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' as const };
