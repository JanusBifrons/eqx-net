/**
 * The Build tab for a processor whose recipes are hulls (a Shipyard): the
 * queue as pictures. A strip on top shows the hull being built (its progress
 * fill, ×N builds left, ∞ when forever; tap = one fewer) beside the ∞ toggle;
 * below, one `HullTile` per hull the yard can build, each with its bill as
 * `CostChips`. Tap a tile = +1, hold ~500 ms = +5; a different hull asks
 * first, since today's single-recipe queue is replaced (`buildQueueIntent`).
 * The blueprint slot row sits under the grid. Other processors keep the
 * modal's recipe / count controls.
 */
import { useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { getShipKind } from '@shared-types/shipKinds';
import { hullKindOf, type RecipeId } from '@shared-types/recipes';
import { HUD } from '../hud/tokens';
import { HullTile } from './HullTile';
import { CostChips } from './CostChips';
import { hullRecipesFor, type ProductionView } from './structureSettingsProduction';
import { addIntent, foreverIntent, removeOneIntent, sendQueueIntent, type QueueIntent } from './buildQueueIntent';
import { sendBlueprintSlot } from '../structures/structureActionsClient';
import { useHoldPress, type HoldPressHandlers } from './useHoldPress';

const C = HUD.color;
/** Press this long on a tile to add five. */
export const HOLD_MS = 500;
const HOLD_ADD = 5;

export interface BuildSx { labelSx: object; valueSx: object; btnSx: object }

/** The ship a hull recipe builds, by name ("Interceptor"). */
function hullName(recipe: RecipeId): string {
  const k = hullKindOf(recipe);
  return k === null ? recipe : getShipKind(k).displayName;
}

/** "×3", "∞", or "Done" for the head badge. */
export function queueBadge(left: number | undefined): string {
  if (left === undefined) return '∞';
  return left === 0 ? 'Done' : `×${left}`;
}

/** The slot holds no blueprint for this hull, as far as the client can tell:
 *  only the slot is mirrored (no product, no storage list), so only the
 *  current hull with an empty slot (and no last run building) is known locked. */
export function tileLocked(p: ProductionView, recipe: RecipeId): boolean {
  return recipe === p.recipe && p.needsBlueprint && p.blueprintLine === undefined && p.lastRunLine === undefined;
}

/** The blueprint slot: what is loaded, Load / Swap and Unload. */
export function BlueprintRow({ entityId, p, labelSx, valueSx, btnSx }: { entityId: number; p: ProductionView } & BuildSx): JSX.Element | null {
  const { needsBlueprint, blueprintLine, lastRunLine } = p;
  if (!needsBlueprint && blueprintLine === undefined) return null;
  return (
    <>
      <Box sx={labelSx}>Blueprint</Box>
      <Box sx={ROW_SX}>
        <Box sx={valueSx} data-testid="settings-blueprint">{(blueprintLine ?? lastRunLine)?.replace(/^BLUEPRINT /, '') ?? 'None loaded'}</Box>
        {needsBlueprint && (
          <Tooltip title={blueprintLine !== undefined ? 'Swap in the best blueprint from storage' : 'Load a blueprint from storage'}>
            <Box component="button" sx={btnSx} data-testid="structure-action-load-blueprint"
              onClick={() => sendBlueprintSlot(entityId, 'load')}>{blueprintLine !== undefined ? 'Swap' : 'Load'}</Box>
          </Tooltip>
        )}
        {blueprintLine !== undefined && (
          <Tooltip title="Put the blueprint back in storage">
            <Box component="button" sx={btnSx} data-testid="structure-action-unload-blueprint"
              onClick={() => sendBlueprintSlot(entityId, 'unload')}>Unload</Box>
          </Tooltip>
        )}
      </Box>
    </>
  );
}

/** Tap / hold handlers for one tile: a hold fires once at HOLD_MS and eats the click. */
function useTapHold(onAdd: (add: number) => void): HoldPressHandlers {
  return useHoldPress(HOLD_MS, () => onAdd(HOLD_ADD), () => onAdd(1)).handlers;
}

function BuildTile({ recipe, p, onIntent }: { recipe: RecipeId; p: ProductionView; onIntent: (i: QueueIntent) => void }): JSX.Element {
  const current = recipe === p.recipe;
  const tap = useTapHold((add) => onIntent(addIntent(p, recipe, add)));
  return (
    <HullTile
      kind={hullKindOf(recipe) ?? ''} name={hullName(recipe)} testId={`build-tile-${recipe}`}
      data={{ current: current ? '1' : '0', locked: tileLocked(p, recipe) ? '1' : '0' }}
      edge={current ? C.auto : C.edge2} glow={current ? `0 0 0 1px ${C.auto}` : 'none'} pressed={current}
      locked={tileLocked(p, recipe)} {...tap}
    >
      <CostChips recipe={recipe} />
    </HullTile>
  );
}

export function HullBuildTab({ entityId, p, sx }: { entityId: number; p: ProductionView; sx: BuildSx }): JSX.Element {
  const [ask, setAsk] = useState<Extract<QueueIntent, { kind: 'confirm' }> | null>(null);
  const onIntent = (i: QueueIntent): void => {
    if (i?.kind === 'confirm') setAsk(i);
    else { setAsk(null); sendQueueIntent(entityId, i); }
  };
  const forever = p.left === undefined;
  return (
    <Box data-testid="structure-settings-production" data-recipe={p.recipe} data-left={p.left ?? 'forever'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box sx={{ width: 72, flex: 'none' }}>
          <HullTile
            kind={hullKindOf(p.recipe) ?? ''} name={hullName(p.recipe)} testId="build-queue-head"
            data={{ left: p.left === undefined ? 'forever' : String(p.left) }}
            edge={C.auto} badge={queueBadge(p.left)} progress={p.frac} locked={tileLocked(p, p.recipe)}
            onClick={() => onIntent(removeOneIntent(p))}
          />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
          <Box sx={sx.labelSx}>Building</Box>
          <Box sx={{ fontSize: 11, color: C.inkDim, lineHeight: 1.3 }}>Tap a hull to add one, hold for five. Tap the queue to remove one.</Box>
          <Tooltip title={forever ? 'Stop repeating: build one' : 'Repeat forever'}>
            <Box component="button" sx={{ ...sx.btnSx, alignSelf: 'flex-start', ...(forever ? { color: C.auto, borderColor: C.auto } : {}) }}
              aria-pressed={forever} aria-label="Repeat forever" data-testid="build-queue-forever" onClick={() => onIntent(foreverIntent(p))}>∞</Box>
          </Tooltip>
        </Box>
      </Box>
      {ask !== null && (
        <Box data-testid="build-switch-ask" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 12, color: C.ink, border: `1px solid ${C.edge2}`, borderRadius: '4px', p: '6px 8px' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>Switch to {hullName(ask.recipe)}? Replaces the queue.</Box>
          <Box component="button" sx={sx.btnSx} data-testid="build-switch-confirm" onClick={() => onIntent({ kind: 'send', recipe: ask.recipe, count: ask.count })}>Switch</Box>
          <Box component="button" sx={sx.btnSx} data-testid="build-switch-cancel" onClick={() => setAsk(null)}>Cancel</Box>
        </Box>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '6px' }}>
        {hullRecipesFor(p.kindId).map((r) => <BuildTile key={r} recipe={r} p={p} onIntent={onIntent} />)}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, fontSize: 13 }}>
        <BlueprintRow entityId={entityId} p={p} {...sx} />
      </Box>
    </Box>
  );
}

const ROW_SX = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 } as const;
