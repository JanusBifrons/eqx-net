/**
 * A recipe's bill as small chips: each input good's cargo icon (the loot
 * window's `CargoIcon`, row key `g:<good>`) and how many one build takes.
 * Inputs come only from `RECIPES[id].inputs`.
 */
import { Box } from '@mui/material';
import { GOOD_DEFS, type GoodId } from '../../shared-types/goods';
import { RECIPES, type RecipeId } from '../../shared-types/recipes';
import { CargoIcon } from './cargoIcons';
import { HUD } from '../hud/tokens';

/** "400", "1.2k", "12k": short enough for a 92 px tile. */
export function shortQty(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? Math.round(k * 10) / 10 : Math.round(k)}k`;
}

/** The recipe's inputs in catalogue order, zero counts dropped. */
export function recipeBill(recipe: RecipeId): Array<{ good: GoodId; n: number }> {
  const out: Array<{ good: GoodId; n: number }> = [];
  for (const [good, n] of Object.entries(RECIPES[recipe].inputs)) if (n !== undefined && n > 0) out.push({ good: good as GoodId, n });
  return out;
}

export type Bill = Array<{ good: GoodId; n: number }>;

/** A goods bill (any source: a recipe, an upgrade) as chips. */
export function BillChips({ bill, testId }: { bill: Bill; testId: string }): JSX.Element {
  return (
    <Box data-testid={testId} sx={{ display: 'flex', flexWrap: 'wrap', gap: '2px 5px' }}>
      {bill.map(({ good, n }) => (
        <Box key={good} data-testid={`cost-chip-${good}`} data-n={n} title={`${n} ${GOOD_DEFS[good].displayName}`}
          sx={{ display: 'flex', alignItems: 'center', gap: '2px', fontFamily: HUD.font.num, fontSize: 10, color: HUD.color.inkDim, lineHeight: 1 }}>
          <Box component="span" sx={{ width: 12, height: 12, flex: 'none', display: 'inline-flex' }}><CargoIcon rowKey={`g:${good}`} /></Box>
          {shortQty(n)}
        </Box>
      ))}
    </Box>
  );
}

export function CostChips({ recipe }: { recipe: RecipeId }): JSX.Element {
  return <BillChips bill={recipeBill(recipe)} testId={`cost-chips-${recipe}`} />;
}
