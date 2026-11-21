/**
 * The building-MANAGEMENT controls of the settings side panel's Manage tab
 * (`StructureManageTab`, every building; a gate's access control sits above
 * them), laid out for a ~280-360 px panel: the Upgrade card on top (next
 * level, minerals + goods as `BillChips`), a compact Reconnect / Clear row,
 * and Deconstruct at the bottom as the danger action, hold-to-confirm
 * (`useHoldPress`); a running deconstruction cancels with a tap. The
 * inspector card's Open button opens the panel in Build mode
 * (`canManageBuildings`); the card keeps only one-shot pilot services
 * (repair, refine). Read from the structure slice at the panel's 4 Hz cadence.
 */
import { useEffect, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { sendStructureAction, sendUpgradeStructure } from '../structures/structureActionsClient';
import { getGameClient } from '../net/clientSingleton';
import { canUpgradeStructure, structureUpgradeCost, structureUpgradeGoods } from '@core/leveling/structureLevel';
import { getStructureKind } from '@shared-types/structureKinds';
import { GOOD_DEFS, type GoodId } from '@shared-types/goods';
import { phoneTiny } from './inspectorSizes';
import { HUD } from '../hud/tokens';
import { useHudSize } from '../hud/useHudScale';
import { WINDOW_BTN_SECONDARY_SX } from './GameWindow';
import { BillChips, type Bill } from './CostChips';
import { useHoldPress } from './useHoldPress';

// The inspector card's icon-button look (EntityStatsPanel's one-shot actions).
export const ACTION_BTN_SX = {
  p: '2px',
  color: 'rgba(180,220,255,0.85)',
  '&:hover': { color: '#cde', bgcolor: 'rgba(120,200,255,0.15)' },
};
export const ICON_SX = phoneTiny({ fontSize: [16, 28] });

/** Hold Deconstruct this long to confirm. */
export const DECONSTRUCT_HOLD_MS = 1000;

/** What the management controls read. */
export interface ManageActionData {
  isDeconstructing?: boolean;
  isConnector?: boolean;
  canUpgrade?: boolean;
  /** "12 Alloy, 3 Components": the goods part of the upgrade bill (also the change key for `upgradeBill`). */
  upgradeGoods?: string;
  upgradeBill?: Bill;
  /** The level now, and the minerals the next one costs (shown when `canUpgrade`). */
  level?: number;
  upgradeMinerals?: number;
}

/** The management state of a building from its slice: Upgrade shows when it
 *  is BUILT, not deconstructing and below the level cap; level 3+ also costs
 *  goods, taken from base storage when it starts (P2e). */
export function readManageData(entityId: number): ManageActionData | null {
  const client = getGameClient();
  const st = client?.mirror.structures?.get(entityId);
  const kindId = client?.mirror.swarm?.get(entityId)?.shipKind;
  if (!st || !kindId) return null;
  const level = st.level ?? 1;
  const data: ManageActionData = {
    isDeconstructing: st.isDeconstructing === true,
    isConnector: kindId === 'connector',
    canUpgrade: st.built === true && st.isDeconstructing !== true && canUpgradeStructure(level),
  };
  if (data.canUpgrade) {
    const base = getStructureKind(kindId).constructionCost;
    data.level = level;
    data.upgradeMinerals = structureUpgradeCost(base, level);
    const bill = structureUpgradeGoods(base, level);
    const goods: Bill = [];
    for (const g of Object.keys(bill) as GoodId[]) { const n = bill[g]; if (n !== undefined && n > 0) goods.push({ good: g, n }); }
    if (goods.length > 0) {
      data.upgradeBill = goods;
      data.upgradeGoods = goods.map(({ good, n }) => `${n} ${GOOD_DEFS[good].displayName}`).join(', ');
    }
  }
  return data;
}

function sameManage(a: ManageActionData | null, b: ManageActionData | null): boolean {
  if (a === null || b === null) return a === b;
  return a.isDeconstructing === b.isDeconstructing && a.isConnector === b.isConnector
    && a.canUpgrade === b.canUpgrade && a.upgradeGoods === b.upgradeGoods
    && a.level === b.level && a.upgradeMinerals === b.upgradeMinerals;
}

/** The settings panel's Manage tab controls, polled at the panel's cadence. */
export function StructureManageTab({ entityId, pollMs }: { entityId: number; pollMs: number }): JSX.Element | null {
  const [d, setD] = useState<ManageActionData | null>(() => readManageData(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setD((prev) => {
      const next = readManageData(entityId);
      return sameManage(prev, next) ? prev : next;
    }), pollMs);
    return () => window.clearInterval(h);
  }, [entityId, pollMs]);
  if (d === null) return null;
  return (
    <Box data-testid="structure-settings-manage" sx={MANAGE_SX}>
      <StructureManageActions entityId={entityId} data={d} />
    </Box>
  );
}

export function StructureManageActions({ entityId, data }: { entityId: number; data: ManageActionData }): JSX.Element {
  return (
    <>
      {data.canUpgrade && <UpgradeCard entityId={entityId} data={data} />}
      <Box sx={SECTION_SX}>
        <Box sx={LABEL_SX}>Connections</Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Reconnect to the nearest structure">
            <Box component="button" data-testid="structure-action-reconnect" sx={ROW_BTN_SX}
              onClick={() => sendStructureAction(entityId, 'reconnect')}>Reconnect</Box>
          </Tooltip>
          {data.isConnector && (
            <Tooltip title="Clear all connections">
              <Box component="button" data-testid="structure-action-clear" sx={ROW_BTN_SX}
                onClick={() => sendStructureAction(entityId, 'clear_connections')}>Clear</Box>
            </Tooltip>
          )}
        </Box>
      </Box>
      <Box sx={{ ...SECTION_SX, borderTop: `1px solid ${C.panelEdge}`, pt: 1.25, mt: 0.5 }}>
        {data.isDeconstructing
          ? <CancelDeconstruct entityId={entityId} />
          : <HoldDeconstruct entityId={entityId} />}
      </Box>
    </>
  );
}

/** Next level, its bill and the button (a paid level-up build phase, WS-B4);
 *  gated to BUILT + below-cap by `readManageData`; the panel is owner-only. */
function UpgradeCard({ entityId, data }: { entityId: number; data: ManageActionData }): JSX.Element {
  const level = data.level ?? 1;
  return (
    <Box data-testid="structure-upgrade-card" data-level={level} sx={CARD_SX}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Box sx={LABEL_SX}>Upgrade</Box>
        <Box sx={{ ml: 'auto', fontFamily: HUD.font.num, fontSize: 12, color: C.ink }}>Lv {level} → {level + 1}</Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Box data-testid="structure-upgrade-minerals" sx={{ fontFamily: HUD.font.num, fontSize: 11, color: C.inkDim }}>
            {data.upgradeMinerals ?? 0} minerals
          </Box>
          {data.upgradeBill !== undefined && <BillChips bill={data.upgradeBill} testId="structure-upgrade-goods" />}
        </Box>
        <Tooltip title={data.upgradeGoods !== undefined ? `Upgrade (minerals + ${data.upgradeGoods} from base storage)` : 'Upgrade (paid level-up: boosts this structure\x27s key stat)'}>
          <Box component="button" data-testid="structure-action-upgrade" sx={UPGRADE_BTN_SX}
            onClick={() => sendUpgradeStructure(entityId)}>Upgrade</Box>
        </Tooltip>
      </Box>
    </Box>
  );
}

/** Press and hold ~1 s to deconstruct; the fill shows the hold; letting go early cancels. */
function HoldDeconstruct({ entityId }: { entityId: number }): JSX.Element {
  const noHover = useHudSize() !== 'desk'; // a tap also fires a hover: desk-only tip
  const { holding, handlers } = useHoldPress(DECONSTRUCT_HOLD_MS, () => sendStructureAction(entityId, 'toggle_deconstruct'));
  return (
    <Tooltip title="Hold to deconstruct (reverse build, returns resources)" disableTouchListener disableHoverListener={noHover} disableFocusListener={noHover}>
      <Box component="button" data-testid="structure-action-deconstruct" data-active="0" data-holding={holding ? '1' : '0'}
        aria-label="Hold to deconstruct" sx={DANGER_BTN_SX} {...handlers}
        onContextMenu={(e: { preventDefault: () => void }) => e.preventDefault()}>
        <Box aria-hidden sx={{
          position: 'absolute', inset: 0, bgcolor: 'rgba(255,77,106,0.28)', transformOrigin: 'left',
          transform: holding ? 'scaleX(1)' : 'scaleX(0)',
          transition: holding ? `transform ${DECONSTRUCT_HOLD_MS}ms linear` : 'none',
        }} />
        <Box component="span" sx={{ position: 'relative' }}>{holding ? 'Keep holding…' : 'Hold to deconstruct'}</Box>
      </Box>
    </Tooltip>
  );
}

/** A deconstruction in progress: one tap stops it (nothing is lost). */
function CancelDeconstruct({ entityId }: { entityId: number }): JSX.Element {
  return (
    <Tooltip title="Cancel deconstruction">
      <Box component="button" data-testid="structure-action-deconstruct" data-active="1" sx={ROW_BTN_SX}
        onClick={() => sendStructureAction(entityId, 'toggle_deconstruct')}>Cancel deconstruction</Box>
    </Tooltip>
  );
}

const C = HUD.color;
const MANAGE_SX = { display: 'flex', flexDirection: 'column', gap: 1.25, pt: 1, maxWidth: 420 } as const;
const SECTION_SX = { display: 'flex', flexDirection: 'column', gap: 0.75 } as const;
const LABEL_SX = { color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' as const } as const;
const CARD_SX = { display: 'flex', flexDirection: 'column', gap: 0.75, p: '8px 10px', bgcolor: C.cell, border: `1px solid ${C.edge2}`, borderRadius: '6px' } as const;
const ROW_BTN_SX = { ...WINDOW_BTN_SECONDARY_SX, height: 32, px: 1.5, fontSize: 12 } as const;
const UPGRADE_BTN_SX = { ...ROW_BTN_SX, flex: 'none', color: C.auto, borderColor: C.autoGlow, '&:hover': { bgcolor: 'rgba(52,216,255,0.12)' } } as const;
const DANGER_BTN_SX = {
  ...WINDOW_BTN_SECONDARY_SX, position: 'relative' as const, overflow: 'hidden', width: '100%',
  color: C.danger, borderColor: 'rgba(255,77,106,0.55)', touchAction: 'none' as const, WebkitTouchCallout: 'none', userSelect: 'none' as const,
} as const;
