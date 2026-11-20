/**
 * The building-MANAGEMENT buttons of the inspector card (`EntityStatsPanel`):
 * the settings cog (recipe, blueprint slot, gate access live in its window),
 * deconstruct, reconnect, clear connections, upgrade. Build mode only (`canManageBuildings`); the panel
 * renders this inside its own action row, next to the pilot-service buttons
 * (repair, refine) that show in every mode.
 */
import { IconButton, Tooltip } from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import CancelIcon from '@mui/icons-material/Cancel';
import HubIcon from '@mui/icons-material/Hub';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { sendStructureAction, sendUpgradeStructure } from '../structures/structureActionsClient';
import { StructureSettingsCog } from './StructureSettingsModal';
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

/** The card fields the management buttons read (a subset of the panel's data). */
export interface ManageActionData {
  name?: string;
  isDeconstructing?: boolean;
  isConnector?: boolean;
  canUpgrade?: boolean;
  upgradeGoods?: string;
}

export function StructureManageActions({ entityId, data }: { entityId: number; data: ManageActionData }): JSX.Element {
  return (
    <>
      <StructureSettingsCog entityId={entityId} title={data.name ?? ''} />
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
        // WS-B4 — a paid Upgrade (level-up build phase). Gated to OWNED +
        // BUILT + below-cap (set in the panel's readData).
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
