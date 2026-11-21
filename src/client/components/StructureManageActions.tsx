/**
 * The building-MANAGEMENT buttons: deconstruct, reconnect, clear connections,
 * upgrade. They live in the settings side panel's Manage tab
 * (`StructureManageTab`, every building; a gate's access control sits above
 * them), which the inspector card's Open button opens in Build mode
 * (`canManageBuildings`). The card keeps only one-shot pilot services
 * (repair, refine). Read from the structure slice at the panel's 4 Hz cadence.
 */
import { useEffect, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import CancelIcon from '@mui/icons-material/Cancel';
import HubIcon from '@mui/icons-material/Hub';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { sendStructureAction, sendUpgradeStructure } from '../structures/structureActionsClient';
import { getGameClient } from '../net/clientSingleton';
import { canUpgradeStructure, structureUpgradeGoods } from '@core/leveling/structureLevel';
import { getStructureKind } from '@shared-types/structureKinds';
import { GOOD_DEFS, type GoodId } from '@shared-types/goods';
import { phoneTiny } from './inspectorSizes';

export const ACTION_BTN_SX = {
  p: '2px',
  color: 'rgba(180,220,255,0.85)',
  '&:hover': { color: '#cde', bgcolor: 'rgba(120,200,255,0.15)' },
};
const ACTION_BTN_WARN_SX = {
  p: '2px',
  color: '#ff9b6b',
  '&:hover': { color: '#ffb892', bgcolor: 'rgba(255,120,80,0.15)' },
};
export const ICON_SX = phoneTiny({ fontSize: [16, 28] });

/** What the management buttons read. */
export interface ManageActionData {
  isDeconstructing?: boolean;
  isConnector?: boolean;
  canUpgrade?: boolean;
  upgradeGoods?: string;
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
    const bill = structureUpgradeGoods(getStructureKind(kindId).constructionCost, level);
    const parts = (Object.keys(bill) as GoodId[]).map((g) => `${bill[g]} ${GOOD_DEFS[g].displayName}`);
    if (parts.length > 0) data.upgradeGoods = parts.join(', ');
  }
  return data;
}

function sameManage(a: ManageActionData | null, b: ManageActionData | null): boolean {
  if (a === null || b === null) return a === b;
  return a.isDeconstructing === b.isDeconstructing && a.isConnector === b.isConnector
    && a.canUpgrade === b.canUpgrade && a.upgradeGoods === b.upgradeGoods;
}

/** The settings panel's Manage tab buttons (the layout is redesigned in A3). */
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
    <Box data-testid="structure-settings-manage" sx={MANAGE_ROW_SX}>
      <StructureManageActions entityId={entityId} data={d} />
    </Box>
  );
}

const MANAGE_ROW_SX = { display: 'flex', gap: 1, pt: 1 } as const;

export function StructureManageActions({ entityId, data }: { entityId: number; data: ManageActionData }): JSX.Element {
  return (
    <>
      <Tooltip title={data.isDeconstructing ? 'Cancel deconstruction' : 'Deconstruct (reverse build, returns resources)'}>
        <IconButton
          data-testid="structure-action-deconstruct"
          data-active={data.isDeconstructing ? '1' : '0'}
          size="small"
          sx={data.isDeconstructing ? ACTION_BTN_WARN_SX : ACTION_BTN_SX}
          onClick={() => sendStructureAction(entityId, 'toggle_deconstruct')}
        >
          {data.isDeconstructing ? <CancelIcon sx={ICON_SX} /> : <DeleteForeverIcon sx={ICON_SX} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Reconnect to the nearest structure">
        <IconButton
          data-testid="structure-action-reconnect"
          size="small"
          sx={ACTION_BTN_SX}
          onClick={() => sendStructureAction(entityId, 'reconnect')}
        >
          <HubIcon sx={ICON_SX} />
        </IconButton>
      </Tooltip>
      {data.isConnector && (
        <Tooltip title="Clear all connections">
          <IconButton
            data-testid="structure-action-clear"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendStructureAction(entityId, 'clear_connections')}
          >
            <LinkOffIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.canUpgrade && (
        // WS-B4 — a paid Upgrade (level-up build phase). Gated to BUILT +
        // below-cap (readManageData); the panel is owner-only.
        <Tooltip title={data.upgradeGoods !== undefined ? `Upgrade (minerals + ${data.upgradeGoods} from base storage)` : 'Upgrade (paid level-up: boosts this structure\x27s key stat)'}>
          <IconButton
            data-testid="structure-action-upgrade"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendUpgradeStructure(entityId)}
          >
            <UpgradeIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}
