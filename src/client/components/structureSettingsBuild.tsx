/**
 * The Build tab for a processor whose recipes are hulls (a Shipyard): the
 * queue as pictures. A strip on top shows the server's recipe queue (the head
 * with its progress fill, then each queued hull; tap one = remove it) under
 * the ∞ (repeat the list) toggle; below, one `HullTile` per hull the yard can
 * build, each with its bill as `CostChips`. Tap a tile = add one to the back
 * of the queue, hold ~500 ms = five (capped at MAX_RECIPE_QUEUE); hulls mix
 * freely (`edit_recipe_queue`). A tile is locked when neither the slot nor
 * the network's storage holds its blueprint. The blueprint slot row sits
 * under the grid. Other processors get the recipe / count rows (`ProductionTab`).
 */
import { useEffect, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { getShipKind } from '@shared-types/shipKinds';
import { RECIPES, hullKindOf, type RecipeId } from '@shared-types/recipes';
import { MAX_BUILD_COUNT, MAX_RECIPE_QUEUE, nextRecipe } from '@shared-types/production';
import { HUD } from '../hud/tokens';
import { HullTile } from './HullTile';
import { CostChips, recipeBill } from './CostChips';
import { GOOD_DEFS } from '@shared-types/goods';
import { buildCountText, hullRecipesFor, readProduction, sameProduction, type ProductionView } from './structureSettingsProduction';
import {
  BUILD_SX, COUNT_SX, GRID_SX, LABEL_SX, ROW_SX as NOTE_SX, SETTINGS_POLL_MS, STEP_BTN_SX, STEPPER_SX, VALUE_SX,
} from './structureSettingsSx';
import { sendBlueprintSlot, sendEditRecipeQueue, sendSetRecipe } from '../structures/structureActionsClient';
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

/** A build tile's desktop hover text: the hull, its bill, and why it is
 *  locked ("Interceptor: 40 Minerals, 10 Alloy"). */
export function buildTileTip(p: ProductionView, recipe: RecipeId): string {
  const bill = recipeBill(recipe).map(({ good, n }) => `${n} ${GOOD_DEFS[good].displayName}`).join(', ');
  const tip = bill === '' ? hullName(recipe) : `${hullName(recipe)}: ${bill}`;
  return tileLocked(p, recipe) ? `${tip}. Locked: no blueprint in the slot or storage` : tip;
}

/** The head's badge: "×3" builds left (a plain `set_recipe` count), "∞" when
 *  forever, "Done"; none for a single build (every queue entry is one). */
export function queueBadge(left: number | undefined): string | undefined {
  if (left === undefined) return '∞';
  if (left === 0) return 'Done';
  return left === 1 ? undefined : `×${left}`;
}

/** Neither the slot nor the network's storage holds a blueprint for this
 *  hull (a queue swaps one in from storage), so it cannot be built. */
export function tileLocked(p: ProductionView, recipe: RecipeId): boolean {
  if (!RECIPES[recipe].blueprintRequired) return false;
  return p.bpProduct !== recipe && !p.bpAvailable.includes(recipe);
}

/** The queue repeats: the list loops, or a plain forever count. */
export function isForever(p: ProductionView): boolean {
  return p.repeat || p.left === undefined;
}

/** Tap (+1) or hold (+5) on a tile: that many adds, capped so the queue
 *  (head included) stays within MAX_RECIPE_QUEUE. Returns how many were sent. */
export function addHulls(entityId: number, p: ProductionView, recipe: RecipeId, n: number): number {
  const k = Math.min(n, Math.max(0, MAX_RECIPE_QUEUE - 1 - p.queue.length));
  for (let i = 0; i < k; i++) sendEditRecipeQueue(entityId, { op: 'add', recipe });
  return k;
}

/** Tap on queue item `index` (0 = the head): remove it. A lone head with a
 *  plain count (`set_recipe`) keeps the one-fewer tap, stopping at 1: the
 *  server never removes the last entry. */
export function removeAt(entityId: number, p: ProductionView, index: number): void {
  if (index === 0 && p.queue.length === 0) {
    if (p.left !== undefined && p.left > 1) sendSetRecipe(entityId, p.recipe, p.left - 1);
    return;
  }
  sendEditRecipeQueue(entityId, { op: 'remove', index });
}

/** The ∞ toggle: loop the queue on / off. A plain forever count (no queue
 *  yet) turns off as one build, the only way out of it. */
export function toggleRepeat(entityId: number, p: ProductionView): void {
  if (!p.repeat && p.left === undefined) sendSetRecipe(entityId, p.recipe, 1);
  else sendEditRecipeQueue(entityId, { op: 'repeat', on: !p.repeat });
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

function BuildTile({ entityId, recipe, p }: { entityId: number; recipe: RecipeId; p: ProductionView }): JSX.Element {
  const current = recipe === p.recipe;
  const locked = tileLocked(p, recipe);
  const tap = useTapHold((add) => { addHulls(entityId, p, recipe, add); });
  return (
    <HullTile
      kind={hullKindOf(recipe) ?? ''} name={hullName(recipe)} testId={`build-tile-${recipe}`}
      data={{ current: current ? '1' : '0', locked: locked ? '1' : '0' }}
      edge={current ? C.auto : C.edge2} glow={current ? `0 0 0 1px ${C.auto}` : 'none'} pressed={current}
      locked={locked} tooltip={buildTileTip(p, recipe)} {...tap}
    >
      <CostChips recipe={recipe} />
    </HullTile>
  );
}

/** The queue strip: the head (progress fill, count badge) then each queued
 *  hull; tap one to remove it. A loaded head is building, never locked. */
function QueueStrip({ entityId, p }: { entityId: number; p: ProductionView }): JSX.Element {
  return (
    <Box data-testid="build-queue" data-len={1 + p.queue.length} sx={{ display: 'flex', gap: '6px', overflowX: 'auto', pb: '2px' }}>
      <Box sx={{ width: 72, flex: 'none' }}>
        <HullTile
          kind={hullKindOf(p.recipe) ?? ''} name={hullName(p.recipe)} testId="build-queue-head"
          data={{ left: p.left === undefined ? 'forever' : String(p.left), index: '0', recipe: p.recipe }}
          edge={C.auto} badge={queueBadge(p.left)} progress={p.frac}
          locked={p.frac === undefined && tileLocked(p, p.recipe)}
          onClick={() => removeAt(entityId, p, 0)}
        />
      </Box>
      {p.queue.map((r, i) => (
        <Box key={i} sx={{ width: 60, flex: 'none' }}>
          <HullTile
            kind={hullKindOf(r) ?? ''} name={hullName(r)} testId={`build-queue-item-${i + 1}`}
            data={{ index: String(i + 1), recipe: r }} locked={tileLocked(p, r)} tooltip={`${hullName(r)}: click to remove`}
            onClick={() => removeAt(entityId, p, i + 1)}
          />
        </Box>
      ))}
    </Box>
  );
}

export function HullBuildTab({ entityId, p, sx }: { entityId: number; p: ProductionView; sx: BuildSx }): JSX.Element {
  const forever = isForever(p);
  return (
    <Box data-testid="structure-settings-production" data-recipe={p.recipe} data-left={p.left ?? 'forever'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 0, flex: 1 }}>
          <Box sx={sx.labelSx}>Building</Box>
          <Box sx={{ fontSize: 11, color: C.inkDim, lineHeight: 1.3 }}>Tap a hull to queue one, hold for five. Tap the queue to remove one.</Box>
        </Box>
        <Tooltip title={forever ? 'Stop repeating' : 'Repeat the queue'}>
          <Box component="button" sx={{ ...sx.btnSx, flex: 'none', ...(forever ? { color: C.auto, borderColor: C.auto } : {}) }}
            aria-pressed={forever} aria-label="Repeat forever" data-testid="build-queue-forever" onClick={() => toggleRepeat(entityId, p)}>∞</Box>
        </Tooltip>
      </Box>
      <QueueStrip entityId={entityId} p={p} />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '6px' }}>
        {hullRecipesFor(p.kindId).map((r) => <BuildTile key={r} entityId={entityId} recipe={r} p={p} />)}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, fontSize: 13 }}>
        <BlueprintRow entityId={entityId} p={p} {...sx} />
      </Box>
    </Box>
  );
}

/** The Build page of the building settings section (StructureSettings.tsx):
 *  recipe (+ Change), build count and the blueprint slot. Minus stops at 1;
 *  Forever clears the count. A hull yard gets the picture tiles above.
 *  Re-reads the mirror at 4 Hz while shown. */
export function ProductionTab({ entityId }: { entityId: number }): JSX.Element {
  const [p, setP] = useState<ProductionView | null>(() => readProduction(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setP((prev) => {
      const next = readProduction(entityId);
      return sameProduction(prev, next) ? prev : next;
    }), SETTINGS_POLL_MS);
    return () => window.clearInterval(h);
  }, [entityId]);
  if (p === null) return <Box sx={NOTE_SX}>No production data</Box>;
  if (p.hullYard) return <HullBuildTab entityId={entityId} p={p} sx={BUILD_SX} />;
  const { recipe, left, canChange } = p;
  const plus = left === undefined ? 1 : Math.min(MAX_BUILD_COUNT, left + 1);
  return (
    <Box data-testid="structure-settings-production" data-recipe={recipe} data-left={left ?? 'forever'} sx={GRID_SX}>
      <Box sx={LABEL_SX}>Makes</Box>
      <Box sx={STEPPER_SX}>
        <Box sx={VALUE_SX} data-testid="settings-production-recipe">{RECIPES[recipe].displayName}</Box>
        {canChange && (
          <Tooltip title="Change what this makes">
            <Box component="button" sx={STEP_BTN_SX} data-testid="structure-action-recipe"
              onClick={() => sendSetRecipe(entityId, nextRecipe(RECIPES[recipe].processors[0]!, recipe))}>Change</Box>
          </Tooltip>
        )}
      </Box>
      <Box sx={LABEL_SX}>Build</Box>
      <Box sx={STEPPER_SX}>
        <Box component="button" sx={STEP_BTN_SX} aria-label="One fewer" data-testid="settings-build-minus"
          disabled={left === undefined || left <= 1} onClick={() => sendSetRecipe(entityId, recipe, left! - 1)}>−</Box>
        <Box sx={COUNT_SX} data-testid="settings-build-count">{buildCountText(left)}</Box>
        <Box component="button" sx={STEP_BTN_SX} aria-label="One more" data-testid="settings-build-plus"
          disabled={left !== undefined && left >= MAX_BUILD_COUNT} onClick={() => sendSetRecipe(entityId, recipe, plus)}>+</Box>
        <Box component="button" sx={STEP_BTN_SX} aria-label="Repeat forever" data-testid="settings-build-forever"
          disabled={left === undefined} onClick={() => sendSetRecipe(entityId, recipe)}>∞</Box>
      </Box>
      <BlueprintRow entityId={entityId} p={p} {...BUILD_SX} />
    </Box>
  );
}

const ROW_SX ={ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 } as const;
